import hmac
import hashlib
import json
import os
import uuid
import mimetypes
from pathlib import Path
from typing import Optional
from fastapi import FastAPI, File, Form, HTTPException, UploadFile, Header, Request, BackgroundTasks
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel

from backend.config import DEFAULT_MODEL
from backend import config, database, analyzer, supabase_client, zernio_client

app = FastAPI(
    title="Docs Manager API",
    description="FastAPI Backend for Cloud Document Storage, Intelligent Extraction & Retrieval",
    version="1.0.0",
)

# Enable CORS for frontend integration
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


class QueryRequest(BaseModel):
    query: str
    api_key: Optional[str] = None
    model: Optional[str] = DEFAULT_MODEL


class ConfigRequest(BaseModel):
    api_key: str
    model: Optional[str] = DEFAULT_MODEL


@app.get("/")
def root():
    sb_cfg = supabase_client.get_supabase_config()
    docs = database.list_documents()
    return {
        "app": "Docs Manager API",
        "status": "online",
        "has_api_key": bool(config.get_api_key()),
        "supabase_enabled": bool(sb_cfg.get("enabled")),
        "documents_count": len(docs),
    }


@app.get("/api/config")
def get_config():
    """Returns whether Gemini API key is configured."""
    key = config.get_api_key()
    masked = f"{key[:6]}...{key[-4:]}" if len(key) > 10 else ("***" if key else "")
    return {
        "has_key": bool(key),
        "masked_key": masked,
        "default_model": DEFAULT_MODEL,
    }


@app.post("/api/config")
def set_config(payload: ConfigRequest):
    """Sets and validates the persistent Gemini API key."""
    key = payload.api_key.strip()
    if not key:
        raise HTTPException(status_code=400, detail="API key cannot be empty")
    valid = analyzer.validate_api_key(key, payload.model or DEFAULT_MODEL)
    if valid:
        config.set_api_key(key)
        return {"valid": True, "message": "API Key saved and active!"}
    return {"valid": False, "message": "Invalid API Key. Please verify."}


@app.post("/api/test-key")
def test_gemini_key(payload: ConfigRequest):
    """Verifies if the provided Gemini API key works and saves if valid."""
    key = payload.api_key.strip()
    valid = analyzer.validate_api_key(key, payload.model or DEFAULT_MODEL)
    if valid:
        config.set_api_key(key)
        return {"valid": True, "message": "API Key is valid and saved!"}
    return {
        "valid": False,
        "message": "Invalid or non-functional API key.",
    }


class SupabaseConfigRequest(BaseModel):
    url: str
    key: str
    bucket: Optional[str] = "documents"
    enabled: Optional[bool] = True


@app.get("/api/supabase/config")
def get_supabase_configuration():
    """Returns whether Supabase storage & metadata are configured."""
    cfg = supabase_client.get_supabase_config()
    key = cfg.get("key", "")
    masked_key = f"{key[:6]}...{key[-4:]}" if len(key) > 10 else ("***" if key else "")
    return {
        "enabled": bool(cfg.get("enabled")),
        "url": cfg.get("url", ""),
        "has_key": bool(key),
        "masked_key": masked_key,
        "bucket": cfg.get("bucket", "documents"),
    }


@app.post("/api/supabase/config")
def save_supabase_configuration(payload: SupabaseConfigRequest):
    """Validates and persists Supabase connection settings."""
    test_res = supabase_client.test_connection(
        url=payload.url,
        key=payload.key,
        bucket=payload.bucket or "documents",
    )
    if not test_res.get("valid"):
        raise HTTPException(
            status_code=400,
            detail=test_res.get("message", "Could not connect to Supabase"),
        )

    cfg = supabase_client.set_supabase_config(
        url=payload.url,
        key=payload.key,
        bucket=payload.bucket or "documents",
        enabled=payload.enabled if payload.enabled is not None else True,
    )
    return {
        "status": "success",
        "message": "Supabase configured and connected successfully!",
        "config": {
            "enabled": cfg["enabled"],
            "url": cfg["url"],
            "bucket": cfg["bucket"],
            "bucket_ready": test_res.get("bucket_ready"),
            "table_ready": test_res.get("table_ready"),
        },
    }


@app.post("/api/supabase/test")
def test_supabase_endpoint(payload: SupabaseConfigRequest):
    """Tests Supabase connection without saving."""
    res = supabase_client.test_connection(
        url=payload.url,
        key=payload.key,
        bucket=payload.bucket or "documents",
    )
    return res


@app.post("/api/upload")
async def upload_document(
    file: UploadFile = File(...),
    api_key: Optional[str] = Form(None),
    model: Optional[str] = Form(DEFAULT_MODEL),
    x_gemini_key: Optional[str] = Header(None),
):
    """
    Receives an uploaded document/image:
    1. AI analyzes it with Gemini Multimodal OCR to extract structured metadata.
    2. Uploads binary file directly to Supabase Storage Bucket.
    3. Saves structured metadata record to Supabase PostgreSQL table.
    No local storage fallback.
    """
    # 1. Check Gemini API key
    if api_key and api_key.strip():
        config.set_api_key(api_key.strip())

    effective_key = (api_key or x_gemini_key or config.get_api_key() or "").strip()
    if not effective_key:
        raise HTTPException(
            status_code=400,
            detail="Gemini API Key is required. Please set GEMINI_API_KEY in Vercel environment variables.",
        )

    # 2. Check Supabase Cloud Storage configuration
    sb_cfg = supabase_client.get_supabase_config()
    if not sb_cfg.get("enabled"):
        raise HTTPException(
            status_code=500,
            detail="Supabase Cloud is not configured. Please set SUPABASE_URL and SUPABASE_KEY in Vercel environment variables.",
        )

    # 3. Read file bytes directly into memory
    contents = await file.read()
    if not contents:
        raise HTTPException(status_code=400, detail="Uploaded file is empty.")

    file_size = len(contents)
    file_ext = Path(file.filename or "").suffix.lower() or ".bin"
    doc_id = uuid.uuid4().hex[:12]
    saved_filename = f"{doc_id}{file_ext}"

    # Determine MIME type
    mime_type = file.content_type
    if not mime_type or mime_type == "application/octet-stream":
        mime_type, _ = mimetypes.guess_type(file.filename or saved_filename)
        if not mime_type:
            mime_type = "image/jpeg"

    # 4. AI analyzes document directly from memory bytes
    analysis = analyzer.analyze_document(
        file_bytes=contents,
        mime_type=mime_type,
        filename=file.filename or saved_filename,
        api_key=effective_key,
        model_name=model or DEFAULT_MODEL,
    )

    # 5. Upload binary file directly to Supabase Storage Bucket
    try:
        sb_info = supabase_client.upload_to_supabase_bucket(
            file_bytes=contents,
            saved_filename=saved_filename,
            mime_type=mime_type,
        )
    except Exception as sb_err:
        err_str = str(sb_err)
        if "row-level security" in err_str.lower() or "403" in err_str:
            detail_msg = (
                "Supabase Storage 403: 'documents' bucket is missing or RLS blocked upload. "
                "Fix: In Supabase Dashboard -> Storage, create a public bucket named 'documents', "
                "or set SUPABASE_KEY in Vercel to your Supabase 'service_role' secret key."
            )
        else:
            detail_msg = f"Failed to upload document to Supabase storage bucket: {sb_err}"
        raise HTTPException(
            status_code=500,
            detail=detail_msg,
        )

    # 6. Save structured metadata record directly to Supabase PostgreSQL table
    try:
        saved_record = database.save_document(
            doc_id=doc_id,
            original_filename=file.filename or saved_filename,
            saved_filename=saved_filename,
            mime_type=mime_type,
            file_size_bytes=file_size,
            analysis=analysis,
            storage_path=sb_info["storage_path"],
            storage_url=sb_info.get("storage_url"),
        )
    except Exception as db_err:
        raise HTTPException(
            status_code=500,
            detail=f"Failed to save document metadata in Supabase database: {db_err}",
        )

    # Return strict thumbs up as required
    return {
        "status": "success",
        "message": "👍",
        "doc_id": doc_id,
        "metadata": saved_record,
    }


@app.post("/api/query")
def query_documents(payload: QueryRequest, x_gemini_key: Optional[str] = Header(None)):
    """
    Intelligently retrieves a document using Gemini AI matching against
    structured metadata stored in Supabase Cloud DB.
    Strictly AI retrieval — no offline/local keyword fallback.
    """
    query = payload.query.strip()
    if not query:
        return {"found": False, "message": "Document not found."}

    effective_key = (payload.api_key or x_gemini_key or config.get_api_key() or "").strip()
    if not effective_key:
        raise HTTPException(
            status_code=400,
            detail="Gemini API Key is required to retrieve documents. Please set GEMINI_API_KEY.",
        )

    # 1. Fetch candidate documents from Supabase PostgreSQL table
    docs = database.list_documents()
    if not docs:
        return {"found": False, "message": "No documents stored in Supabase yet."}

    # 2. Strict AI matching
    matched_doc = analyzer.find_matching_document(
        query=query,
        documents=docs,
        api_key=effective_key,
        model_name=payload.model or DEFAULT_MODEL,
    )

    if not matched_doc:
        return {"found": False, "message": "Document not found."}

    doc_id = matched_doc["doc_id"]
    return {
        "found": True,
        "doc_id": doc_id,
        "document": matched_doc,
        "file_url": f"/api/documents/{doc_id}/file",
        "download_url": f"/api/documents/{doc_id}/file?download=true",
        "storage_url": matched_doc.get("storage_url"),
    }


@app.get("/api/documents")
def get_all_documents():
    """Lists all stored documents directly from Supabase Cloud DB."""
    return {"documents": database.list_documents()}


@app.get("/api/documents/{doc_id}")
def get_document_details(doc_id: str):
    """Gets metadata of a single document directly from Supabase."""
    doc = database.get_document(doc_id)
    if not doc:
        raise HTTPException(status_code=404, detail="Document not found")
    return doc


@app.get("/api/documents/{doc_id}/file")
@app.get("/api/documents/{doc_id}/file/{filename}")
def get_document_file(doc_id: str, filename: Optional[str] = None, download: bool = False):
    """Streams the document binary directly from Supabase Storage bucket."""
    doc = database.get_document(doc_id)
    if not doc:
        raise HTTPException(status_code=404, detail="Document not found")

    fname = filename or doc.get("original_filename") or doc.get("saved_filename") or f"{doc_id}.bin"
    raw_mime = doc.get("mime_type", "application/octet-stream")
    if not raw_mime or "/" not in raw_mime or raw_mime in ["image", "file", "video"]:
        guessed, _ = mimetypes.guess_type(fname)
        mime_type = guessed or "image/jpeg"
    else:
        mime_type = raw_mime

    headers = {
        "Content-Type": mime_type,
        "Accept-Ranges": "bytes",
    }
    if download:
        headers["Content-Disposition"] = f'attachment; filename="{fname}"'
    else:
        headers["Content-Disposition"] = f'inline; filename="{fname}"'

    storage_path = doc.get("storage_path") or f"uploads/{doc.get('saved_filename')}"
    file_bytes = supabase_client.download_from_supabase_bucket(storage_path)
    if file_bytes:
        return Response(
            content=file_bytes,
            media_type=mime_type,
            headers=headers,
        )

    raise HTTPException(status_code=404, detail="Document file not found in Supabase storage bucket")


@app.delete("/api/documents/{doc_id}")
def remove_document(doc_id: str):
    """Deletes a document from Supabase storage bucket and metadata table."""
    success = database.delete_document(doc_id)
    if not success:
        raise HTTPException(status_code=404, detail="Document not found")
    return {"status": "success", "message": f"Document {doc_id} deleted"}


# =============================================================================
# Zernio (WhatsApp & SMS) Webhook & Integration Endpoints
# =============================================================================

@app.get("/api/zernio/webhook")
@app.get("/api/zernio/webhoo")
def zernio_webhook_health():
    """Health check endpoint for Zernio webhook registration."""
    api_key = zernio_client.get_zernio_api_key()
    return {
        "status": "online",
        "service": "Zernio WhatsApp / SMS Webhook",
        "has_api_key": bool(api_key),
        "endpoint": "/api/zernio/webhook",
    }


@app.post("/api/zernio/webhook")
@app.post("/api/zernio/webhoo")
async def handle_zernio_webhook(
    request: Request,
    x_zernio_event_id: Optional[str] = Header(None),
    x_zernio_signature: Optional[str] = Header(None),
):
    """
    Receives incoming WhatsApp / SMS messages & media uploads from Zernio.
    Signature check is optional: only enforced if ZERNIO_WEBHOOK_SECRET is set in Vercel.
    - If media uploaded: Analyzes with Gemini Multimodal OCR -> stores in Supabase -> replies '👍'.
    - If natural language query: Searches structured metadata via Gemini AI -> replies with document.
    """
    raw_body = await request.body()
    secret = os.getenv("ZERNIO_WEBHOOK_SECRET", "").strip()

    if secret and x_zernio_signature:
        expected_sig = hmac.new(secret.encode("utf-8"), raw_body, hashlib.sha256).hexdigest()
        clean_sig = x_zernio_signature.replace("sha256=", "").strip()
        if not hmac.compare_digest(expected_sig, clean_sig):
            return JSONResponse(status_code=401, content={"status": "error", "message": "Invalid webhook signature"})

    try:
        payload = json.loads(raw_body.decode("utf-8")) if raw_body else {}
    except Exception as e:
        return JSONResponse(status_code=400, content={"status": "error", "message": f"Invalid JSON: {e}"})

    # Process the message/document directly
    try:
        result = zernio_client.process_incoming_zernio_event(payload)
        return {"status": "success", "result": result}
    except Exception as exc:
        import traceback
        err_trace = traceback.format_exc()
        zernio_client._log_event(f"Webhook processing error: {exc}", {"error": str(exc), "trace": err_trace, "payload": payload})
        return JSONResponse(status_code=200, content={"status": "handled_with_error", "error": str(exc)})


@app.get("/api/zernio/logs")
def get_zernio_debug_logs():
    """Returns recent webhook activity logs for diagnostics."""
    return {
        "status": "online",
        "recent_logs": zernio_client.get_recent_webhook_logs(),
    }


@app.get("/api/zernio/diagnostics")
def get_zernio_diagnostics(zernio_path: Optional[str] = None):
    """Queries Zernio API directly to inspect configured webhooks, accounts, conversations, and logs."""
    import httpx
    api_key = zernio_client.get_zernio_api_key()
    if not api_key:
        return {"error": "ZERNIO_API_KEY is not configured"}

    headers = {"Authorization": f"Bearer {api_key}"}

    with httpx.Client(timeout=10.0) as client:
        # If custom path requested:
        if zernio_path:
            clean_path = zernio_path if zernio_path.startswith("/") else f"/{zernio_path}"
            try:
                r = client.get(f"https://api.zernio.com{clean_path}", headers=headers)
                return r.json() if r.status_code == 200 else {"status": r.status_code, "text": r.text}
            except Exception as e:
                return {"error": str(e)}

        results = {}

        # 1. Webhook Settings
        try:
            wh_res = client.get("https://api.zernio.com/v1/webhooks/settings", headers=headers)
            results["webhooks"] = wh_res.json() if wh_res.status_code == 200 else {"status": wh_res.status_code, "text": wh_res.text}
        except Exception as e:
            results["webhooks"] = {"error": str(e)}

        # 2. Connected Accounts
        try:
            acc_res = client.get("https://api.zernio.com/v1/accounts", headers=headers)
            results["accounts"] = acc_res.json() if acc_res.status_code == 200 else {"status": acc_res.status_code, "text": acc_res.text}
        except Exception as e:
            results["accounts"] = {"error": str(e)}

        # 3. Recent Inbox Conversations
        try:
            conv_res = client.get("https://api.zernio.com/v1/inbox/conversations?accountId=6adf16ad9c74a0a97edb9b33&limit=10", headers=headers)
            results["conversations"] = conv_res.json() if conv_res.status_code == 200 else {"status": conv_res.status_code, "text": conv_res.text}
        except Exception as e:
            results["conversations"] = {"error": str(e)}

        # 4. Recent Activity Logs
        try:
            logs_res = client.get("https://api.zernio.com/v1/logs?type=all&limit=25", headers=headers)
            results["logs"] = logs_res.json() if logs_res.status_code == 200 else {"status": logs_res.status_code, "text": logs_res.text}
        except Exception as e:
            results["logs"] = {"error": str(e)}

    return results


