# 📁 Docs Manager

An intelligent, WhatsApp-style AI document classification and retrieval web application built with **Next.js**, **FastAPI**, **Google Gemini**, and **Supabase**.

Upload any document (Aadhar, PAN, IDs, certificates, invoices, etc.) via attachment, drag & drop, or clipboard paste (`Ctrl+V`). The app analyzes and extracts structured metadata, stores the file in **Supabase Storage**, and delivers the document instantly when you ask—with **zero chatty filler**.

---

## 🚀 Live Vercel Deployment

This repository is pre-configured for instant zero-configuration deployment on **Vercel** with Next.js and Python FastAPI serverless functions.

### 1. Push to Your GitHub Repository
```bash
git add .
git commit -m "Configure Docs Manager for Vercel deployment"
git push -u origin main
```

### 2. Import into Vercel
1. Go to [Vercel Dashboard](https://vercel.com/new).
2. Import your GitHub repository: `https://github.com/BEPAWSITIVE/docs-manager`.
3. Vercel automatically detects the **Next.js** framework. Leave the root directory as `./`.

### 3. Configure Environment Variables in Vercel
In **Vercel Project Settings → Environment Variables**, add the following keys:

| Variable | Description | Example |
| :--- | :--- | :--- |
| `GEMINI_API_KEY` | Your Google Gemini API Key | `AIzaSy...` |
| `SUPABASE_URL` | Your Supabase Project URL | `https://xxxx.supabase.co` |
| `SUPABASE_KEY` | Supabase `service_role` secret key | `eyJhbGci...` |
| `SUPABASE_BUCKET` | Storage bucket name (default: `documents`) | `documents` |

> **Tip**: You can also configure your Gemini Key and Supabase credentials anytime directly from the **Settings modal (`⚙️`)** in the running web app.

---

## 🗄️ Supabase Cloud Database & Storage Setup

1. In your **Supabase Dashboard → SQL Editor**, run this SQL script:

```sql
-- 1. Create Documents Metadata Table
CREATE TABLE IF NOT EXISTS documents_metadata (
    doc_id TEXT PRIMARY KEY,
    original_filename TEXT NOT NULL,
    saved_filename TEXT NOT NULL,
    storage_path TEXT NOT NULL,
    storage_url TEXT,
    mime_type TEXT,
    file_size_bytes BIGINT,
    document_type TEXT,
    person_name TEXT,
    document_number TEXT,
    issuing_authority TEXT,
    dob TEXT,
    searchable_keywords TEXT[],
    short_summary TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 2. Storage Bucket Setup (allows upload & download)
INSERT INTO storage.buckets (id, name, public) 
VALUES ('documents', 'documents', true) 
ON CONFLICT (id) DO UPDATE SET public = true;

CREATE POLICY "Allow public storage upload" ON storage.objects
FOR INSERT WITH CHECK (bucket_id = 'documents');

CREATE POLICY "Allow public storage select" ON storage.objects
FOR SELECT USING (bucket_id = 'documents');

CREATE POLICY "Allow public storage delete" ON storage.objects
FOR DELETE USING (bucket_id = 'documents');
```

---

## 💻 Local Development

### Prerequisites
- Python 3.10+
- Node.js 18+

### Quick Start
```bash
# 1. Install Python dependencies
pip install -r requirements.txt

# 2. Install Next.js dependencies
npm install

# 3. Start both backend & frontend together
python run.py
```
Or simply double-click **`start_docs_manager.bat`** on Windows.

- **Frontend**: [http://localhost:3000](http://localhost:3000)
- **FastAPI Backend**: [http://127.0.0.1:8005](http://127.0.0.1:8005)

---

## 🛠️ Architecture

- **Frontend**: Next.js 14 App Router, pure CSS WhatsApp Web pixel-perfect clone with real-time feedback.
- **Backend**: FastAPI with Python serverless ASGI handler (`api/index.py`).
- **AI Engine**: Google GenAI (`gemini-2.5-flash`) for multi-format OCR and deterministic in-context document matching.
- **Storage**: Supabase Storage Bucket for binary assets + Supabase PostgreSQL for structured metadata.
- **Zero-Chatter Protocol**: On upload responds with `👍`; on query delivers the document preview and download card directly without conversational filler.
