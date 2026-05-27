# PDF-to-MD Converter

Webapp per convertire PDF e immagini in Markdown pulito usando **LightOnOCR** tramite Ollama.

## Caratteristiche

- **Multi-formato**: Supporta PDF, PNG, JPG, JPEG, TIFF, BMP, WEBP
- **OCR locale**: Utilizza LightOnOCR eseguito localmente via Ollama
- **Streaming OCR**: Risultati in tempo reale mentre il modello elabora
- **Vista affiancata**: Documento originale a sinistra, Markdown a destra
- **Navigazione pagine**: Thumbnail per navigare tra le pagine
- **Caching**: Risultati salvati su disco per non rielaborare
- **Download**: Esporta tutto il documento in un file `.md`

## Requisiti

1. **Python 3.10+**
2. **Ollama** installato e in esecuzione
3. **Modello LightOnOCR**:
   ```bash
   ollama pull Maternion/LightOnOCR-2:latest
   ```

## Installazione

```bash
# Clona il repository
git clone <repo-url>
cd glm-ocr-webapp

# Crea ambiente virtuale (opzionale ma consigliato)
python -m venv venv

# Attiva l'ambiente virtuale
# Windows:
venv\Scripts\activate
# Linux/macOS:
source venv/bin/activate

# Installa le dipendenze
pip install -r requirements.txt
```

## Avvio

1. **Avvia Ollama** (se non e gia in esecuzione):
   ```bash
   ollama serve
   ```

2. **Avvia il server web**:
   ```bash
   python pd-to-md.py
   ```

3. **Apri il browser**:
   ```
   http://localhost:8000
   ```

## Configurazione

Variabili d'ambiente opzionali:

| Variabile | Default | Descrizione |
|-----------|---------|-------------|
| `OLLAMA_URL` | `http://localhost:11434` | URL del server Ollama |
| `OCR_MODEL` | `Maternion/LightOnOCR-2:latest` | Modello OCR da utilizzare |
| `OCR_PROMPT` | *(prompt interno)* | Prompt per l'estrazione del contenuto |
| `RENDER_DPI` | `150` | DPI per rendering PDF |

Esempio:
```bash
export OCR_MODEL=custom-ocr-model:latest
export RENDER_DPI=200
python pd-to-md.py
```

## API Endpoints

| Metodo | Endpoint | Descrizione |
|--------|----------|-------------|
| `POST` | `/api/upload` | Carica PDF/immagine, restituisce job_id |
| `GET` | `/api/page/{job_id}/{page}` | Ottieni immagine pagina |
| `GET` | `/api/ocr/{job_id}/{page}` | Avvia OCR (streaming SSE) |
| `GET` | `/api/markdown/{job_id}` | Scarica tutto il markdown |
| `GET` | `/api/health` | Stato connessione Ollama e modello OCR |
| `DELETE` | `/api/jobs/{job_id}` | Elimina job |

## Streaming Events (SSE)

L'endpoint `/api/ocr/{job_id}/{page}` utilizza Server-Sent Events:

| Evento | Descrizione |
|--------|-------------|
| `cached` | Risultato gia in cache |
| `stage` | Inizio elaborazione OCR |
| `data` | Chunk di testo generato |
| `done` | Elaborazione completata |
| `error` | Errore durante l'elaborazione |

## Struttura Progetto

```
glm-ocr-webapp/
├── pd-to-md.py          # Backend FastAPI
├── requirements.txt     # Dipendenze Python
├── static/
│   ├── index.html      # Frontend HTML
│   ├── app.js          # Logica frontend
│   └── styles.css      # Stili CSS
├── jobs/               # Directory job (auto-creata)
│   └── {job_id}/
│       ├── meta.json   # Metadati job
│       ├── page-*.png  # Immagini pagine
│       └── page-*.md   # Risultati OCR (cache)
└── uploads/            # Upload temporanei
```

## Keyboard Shortcuts

- `<-` / `->` : Naviga tra le pagine
- `Ctrl+S` / `Cmd+S` : Scarica Markdown
- `Escape` : Torna alla schermata upload

## Troubleshooting

### Ollama non trovato
```bash
# Verifica che Ollama sia in esecuzione
ollama list

# Se non parte
ollama serve
```

### Modello non trovato
```bash
# Scarica il modello necessario
ollama pull Maternion/LightOnOCR-2:latest
```

### Timeout su documenti grandi
Il timeout e impostato a 10 minuti. Per documenti molto lunghi, puoi aumentare `RENDER_DPI` per qualita migliore o diminuirlo per performance migliori.

### Caricamento infinito
Se l'OCR sembra bloccato, verifica:
1. Che Ollama sia in esecuzione: `ollama list`
2. Che il modello sia disponibile: controlla `/api/health`
3. Verifica i log del server per errori

## Licenza

MIT
