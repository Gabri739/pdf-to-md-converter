import asyncio
import base64
from datetime import datetime
import json
import os
import re
import shutil
from html.parser import HTMLParser
from pathlib import Path

import fitz  # PyMuPDF
import httpx
from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from PIL import Image

# Configurazione
OLLAMA_URL = os.environ.get("OLLAMA_URL", "http://localhost:11434")
OCR_MODEL = os.environ.get("OCR_MODEL", "Maternion/LightOnOCR-2:latest")
OCR_PROMPT = os.environ.get(
    "OCR_PROMPT",
    "Extract all content from this document image and output clean, well-formatted Markdown. "
    "Preserve headings, paragraphs, lists, and tables. "
    "For tables, ALWAYS use Markdown table syntax with pipes (|) and dashes (-). "
    "Example table format:\n"
    "| Column 1 | Column 2 |\n"
    "|----------|----------|\n"
    "| Value A  | Value B  |\n"
    "NEVER use HTML tags such as <table>, <tr>, or <td>. "
    "Describe figures concisely in italics. Do not add commentary; return only the Markdown."
)
RENDER_DPI = int(os.environ.get("RENDER_DPI", "150"))

# Directory
BASE_DIR = Path(__file__).parent.resolve()
JOBS_DIR = BASE_DIR / "jobs"
STATIC_DIR = BASE_DIR / "static"
JOBS_DIR.mkdir(exist_ok=True)

# Cached health state (updated by background task)
_health_state: dict = {
    "status": "unknown",
    "ollama_connected": False,
    "ollama_url": OLLAMA_URL,
    "ocr_model_available": False,
    "ocr_model": OCR_MODEL,
}


async def _poll_ollama_health() -> None:
    """Background task that polls Ollama every 10 s and caches the result."""
    while True:
        try:
            timeout = httpx.Timeout(connect=1.0, read=3.0, write=3.0, pool=1.0)
            async with httpx.AsyncClient(timeout=timeout) as client:
                response = await client.get(f"{OLLAMA_URL}/api/tags")
                if response.status_code == 200:
                    models = response.json().get("models", [])
                    model_names = [m.get("name", "") for m in models]
                    has_ocr = OCR_MODEL in model_names
                    _health_state.update(
                        {
                            "status": "healthy",
                            "ollama_connected": True,
                            "ocr_model_available": has_ocr,
                        }
                    )
                else:
                    raise RuntimeError("bad status")
        except Exception:
            _health_state.update(
                {
                    "status": "unhealthy",
                    "ollama_connected": False,
                    "ocr_model_available": False,
                }
            )
        await asyncio.sleep(10)


# App
app = FastAPI(title="PDF-to-MD Converter")


@app.on_event("startup")
async def _startup_event() -> None:
    asyncio.create_task(_poll_ollama_health())

# CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Serve static files
if STATIC_DIR.exists():
    app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")


def _job_dir(job_id: str) -> Path:
    safe = "".join(c for c in job_id if c.isalnum() or c in "-_")
    if safe != job_id or not safe:
        raise HTTPException(status_code=400, detail="invalid job id")
    p = JOBS_DIR / safe
    if not p.exists():
        raise HTTPException(status_code=404, detail="job not found")
    return p


def _render_pdf_to_pngs(pdf_path: Path, out_dir: Path) -> int:
    doc = fitz.open(pdf_path)
    try:
        zoom = RENDER_DPI / 72.0
        mat = fitz.Matrix(zoom, zoom)
        for i, page in enumerate(doc, start=1):
            pix = page.get_pixmap(matrix=mat, alpha=False)
            pix.save(out_dir / f"page-{i:04d}.png")
        return doc.page_count
    finally:
        doc.close()


def _save_image_as_page(src: Path, out_dir: Path) -> int:
    with Image.open(src) as im:
        im = im.convert("RGB")
        im.save(out_dir / "page-0001.png", format="PNG")
    return 1


def _html_tables_to_md(text: str) -> str:
    """Convert any HTML <table> blocks in text to Markdown tables, handling rowspan/colspan."""
    if "<table" not in text.lower():
        return text

    class TableParser(HTMLParser):
        def __init__(self) -> None:
            super().__init__()
            self.tables: list[list[list[tuple[str, int, int]]]] = []
            self._current_table: list[list[tuple[str, int, int]]] = []
            self._current_row: list[tuple[str, int, int]] = []
            self._in_cell = False
            self._cell_text: list[str] = []
            self._cell_attrs: dict[str, str | None] = {}

        def _clear_cell(self) -> None:
            self._in_cell = False
            self._cell_text = []
            self._cell_attrs = {}

        def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
            tag = tag.lower()
            if tag == "table":
                self._current_table = []
            elif tag == "tr":
                self._current_row = []
            elif tag in ("td", "th"):
                self._in_cell = True
                self._cell_text = []
                self._cell_attrs = dict(attrs)

        def handle_endtag(self, tag: str) -> None:
            tag = tag.lower()
            if tag in ("td", "th"):
                text = "".join(self._cell_text).strip()
                rowspan = int(self._cell_attrs.get("rowspan", 1) or 1)
                colspan = int(self._cell_attrs.get("colspan", 1) or 1)
                self._current_row.append((text, rowspan, colspan))
                self._clear_cell()
            elif tag == "tr":
                if self._current_row:
                    self._current_table.append(self._current_row)
            elif tag == "table":
                if self._current_table:
                    self.tables.append(self._current_table)

        def handle_data(self, data: str) -> None:
            if self._in_cell:
                self._cell_text.append(data)

    def replace_table(match: re.Match) -> str:
        html = match.group(0)
        parser = TableParser()
        try:
            parser.feed(html)
        except Exception:
            return html

        if not parser.tables:
            return html

        table = parser.tables[0]
        # Build matrix handling colspan and rowspan
        matrix: list[list[str | None]] = []
        pending: dict[tuple[int, int], str] = {}

        for row_idx, row in enumerate(table):
            matrix_row: list[str | None] = []
            col_idx = 0
            while col_idx < len(matrix_row) or (col_idx == len(matrix_row) and row):
                # Check pending rowspan from above
                if (row_idx, col_idx) in pending:
                    matrix_row.append(pending[(row_idx, col_idx)])
                    col_idx += 1
                    continue
                if not row:
                    break
                cell_text, rowspan, colspan = row.pop(0)
                for c in range(colspan):
                    matrix_row.append(cell_text if c == 0 else "")
                    if rowspan > 1:
                        for r in range(1, rowspan):
                            pending[(row_idx + r, col_idx + c)] = cell_text if c == 0 else ""
                col_idx += colspan
            matrix.append(matrix_row)

        if not matrix:
            return html

        max_cols = max(len(r) for r in matrix)
        md_lines: list[str] = []
        for i, row in enumerate(matrix):
            padded = row + [''] * (max_cols - len(row))
            md_lines.append('| ' + ' | '.join(str(c) for c in padded) + ' |')
            if i == 0:
                md_lines.append('|' + '|'.join(['---'] * max_cols) + '|')

        return '\n'.join(md_lines)

    result = re.sub(r'<table[^>]*>.*?</table>', replace_table, text, flags=re.DOTALL | re.IGNORECASE)
    # Strip any leftover table-related tags
    result = re.sub(r'</?(?:table|thead|tbody|tr|th|td)[^>]*>', '', result, flags=re.IGNORECASE)
    return result


def _flush_html_buffer(buffer: str) -> tuple[str, str]:
    """Process a text buffer and emit Markdown for any complete HTML tables.

    Returns (output_to_send, remaining_buffer).  If there is an incomplete
    <table> in the buffer, the text after the last complete table is kept in
    the remaining buffer.
    """
    if "<table" not in buffer.lower():
        return buffer, ""

    output = ""
    remaining = buffer

    while True:
        match = re.search(r'<table.*?</table>', remaining, re.DOTALL | re.IGNORECASE)
        if not match:
            break
        before = remaining[:match.start()]
        table_md = _html_tables_to_md(match.group(0))
        output += before + table_md
        remaining = remaining[match.end():]

    # If no incomplete table is pending, we can also flush the remaining text
    if "<table" not in remaining.lower():
        output += remaining
        remaining = ""

    return output, remaining


# =============================================================================
# API ENDPOINTS
# =============================================================================

@app.post("/api/upload")
async def upload(file: UploadFile = File(...)):
    if not file.filename:
        raise HTTPException(status_code=400, detail="missing filename")
    suffix = Path(file.filename).suffix.lower()
    allowed = {".pdf", ".png", ".jpg", ".jpeg", ".webp", ".bmp", ".tif", ".tiff"}
    if suffix not in allowed:
        raise HTTPException(status_code=400, detail=f"unsupported file type: {suffix}")

    job_id = datetime.now().strftime("%Y%m%d_%H%M%S")
    job_dir = JOBS_DIR / job_id
    job_dir.mkdir()
    src_path = job_dir / f"source{suffix}"

    with src_path.open("wb") as f:
        shutil.copyfileobj(file.file, f)

    try:
        if suffix == ".pdf":
            n_pages = _render_pdf_to_pngs(src_path, job_dir)
        else:
            n_pages = _save_image_as_page(src_path, job_dir)
    except Exception as e:
        shutil.rmtree(job_dir, ignore_errors=True)
        raise HTTPException(status_code=500, detail=f"failed to render: {e}")

    meta = {"job_id": job_id, "filename": file.filename, "pages": n_pages}
    (job_dir / "meta.json").write_text(json.dumps(meta), encoding="utf-8")
    return meta


@app.get("/api/page/{job_id}/{page}")
async def get_page_image(job_id: str, page: int):
    job_dir = _job_dir(job_id)
    img = job_dir / f"page-{page:04d}.png"
    if not img.exists():
        raise HTTPException(status_code=404, detail="page not found")
    return FileResponse(img, media_type="image/png")


@app.get("/api/jobs/{job_id}")
async def get_job(job_id: str):
    job_dir = _job_dir(job_id)
    meta_file = job_dir / "meta.json"
    if not meta_file.exists():
        raise HTTPException(status_code=404, detail="meta missing")
    return JSONResponse(content=json.loads(meta_file.read_text(encoding="utf-8")))


@app.get("/api/ocr/{job_id}/{page}")
async def ocr_page(job_id: str, page: int, refresh: bool = False):
    """Run OCR with LightOnOCR and stream incremental Markdown chunks."""
    job_dir = _job_dir(job_id)
    img_path = job_dir / f"page-{page:04d}.png"
    if not img_path.exists():
        raise HTTPException(status_code=404, detail="page not found")

    cache_path = job_dir / f"page-{page:04d}.md"
    if cache_path.exists() and not refresh:
        cached = cache_path.read_text(encoding="utf-8")

        async def cached_stream():
            yield f"event: cached\ndata: {json.dumps({'cached': True})}\n\n"
            yield f"data: {json.dumps({'chunk': cached})}\n\n"
            yield f"event: done\ndata: {json.dumps({'ok': True})}\n\n"

        return StreamingResponse(cached_stream(), media_type="text/event-stream")

    img_b64 = base64.b64encode(img_path.read_bytes()).decode("ascii")
    timeout = httpx.Timeout(connect=10.0, read=600.0, write=60.0, pool=10.0)

    async def gen():
        final_text = ""
        html_buffer = ""

        yield f"event: stage\ndata: {json.dumps({'stage': 'ocr', 'message': 'Running OCR...'})}\n\n"
        ocr_payload = {
            "model": OCR_MODEL,
            "prompt": OCR_PROMPT,
            "images": [img_b64],
            "stream": True,
            "options": {"temperature": 0.0, "num_predict": 16384},
        }
        try:
            async with httpx.AsyncClient(timeout=timeout) as client:
                async with client.stream("POST", f"{OLLAMA_URL}/api/generate", json=ocr_payload) as resp:
                    if resp.status_code != 200:
                        body = (await resp.aread()).decode("utf-8", errors="replace")
                        err = {"error": f"OCR HTTP {resp.status_code}", "body": body[:500]}
                        yield f"event: error\ndata: {json.dumps(err)}\n\n"
                        return
                    async for line in resp.aiter_lines():
                        if not line:
                            continue
                        try:
                            obj = json.loads(line)
                        except json.JSONDecodeError:
                            continue
                        chunk = obj.get("response", "")
                        if chunk:
                            html_buffer += chunk
                            to_send, html_buffer = _flush_html_buffer(html_buffer)
                            if to_send:
                                final_text += to_send
                                yield f"data: {json.dumps({'chunk': to_send})}\n\n"
                        if obj.get("done"):
                            break
        except httpx.RequestError as e:
            yield f"event: error\ndata: {json.dumps({'error': f'OCR connection error: {str(e)}'})}\n\n"
            return
        except asyncio.CancelledError:
            raise

        # Flush any remaining HTML buffer
        if html_buffer:
            converted = _html_tables_to_md(html_buffer)
            final_text += converted
            yield f"data: {json.dumps({'chunk': converted})}\n\n"
            html_buffer = ""

        if final_text.strip():
            cache_path.write_text(final_text, encoding="utf-8")
        yield f"event: done\ndata: {json.dumps({'ok': True, 'length': len(final_text)})}\n\n"

    return StreamingResponse(gen(), media_type="text/event-stream")


@app.get("/api/markdown/{job_id}/{page}")
async def get_markdown(job_id: str, page: int):
    job_dir = _job_dir(job_id)
    cache_path = job_dir / f"page-{page:04d}.md"
    if not cache_path.exists():
        raise HTTPException(status_code=404, detail="not yet processed")
    return JSONResponse({"page": page, "markdown": cache_path.read_text(encoding="utf-8")})


@app.get("/api/markdown/{job_id}")
async def get_full_markdown(job_id: str):
    job_dir = _job_dir(job_id)
    meta = json.loads((job_dir / "meta.json").read_text(encoding="utf-8"))
    parts: list[str] = []
    for i in range(1, meta["pages"] + 1):
        cache_path = job_dir / f"page-{i:04d}.md"
        if cache_path.exists():
            parts.append(f"<!-- Page {i} -->\n\n" + cache_path.read_text(encoding="utf-8"))
        else:
            parts.append(f"<!-- Page {i} not processed yet -->")
    return JSONResponse({"job_id": job_id, "markdown": "\n\n---\n\n".join(parts)})


@app.delete("/api/jobs/{job_id}")
async def delete_job(job_id: str):
    job_dir = _job_dir(job_id)
    shutil.rmtree(job_dir, ignore_errors=True)
    return JSONResponse({"ok": True})


@app.get("/api/health")
async def health_check():
    """Return cached Ollama health status (updated every ~10 s by background task)."""
    return _health_state


# =============================================================================
# FRONTEND
# =============================================================================

@app.get("/")
async def root():
    """Serve la webapp"""
    index_path = STATIC_DIR / "index.html"
    if index_path.exists():
        return FileResponse(index_path, media_type="text/html")
    return JSONResponse({"error": "Frontend not found. Static files missing."})


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)