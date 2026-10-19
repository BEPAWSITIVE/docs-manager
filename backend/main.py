import os
import uuid
import mimetypes
from pathlib import Path
from typing import Optional
from fastapi import FastAPI, File, Form, HTTPException, UploadFile, Header
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, Response
from pydantic import BaseModel

from backend.config import (
    DOCUMENTS_DIR,
    DEFAULT_MODEL,
    ALLOWED_EXTENSIONS,
)
from backend import config, database, analyzer, supabase_client

app = FastAPI(
    title="Docs Manager API",
    description="FastAPI Backend for Document Storage, Intelligent Extraction & Retrieval",
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
    return {
        "app": "Docs Manager API",
        "status": "online",
        "has_api_key": bool(config.get_api_key()),
        "supabase_enabled": bool(sb_cfg.get("enabled")),
        "documents_count": len(database.list_documents()),
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
        # Reanalyze any pending documents
        reanalyze_unclassified()
        return {"valid": True, "message": "API Key saved and active!"}
    return {"valid": False, "message": "Invalid API Key. Please verify."}


@app.post("/api/test-key")
def test_gemini_key(payload: ConfigRequest):
    """Verifies if the provided Gemini API key works and saves if valid."""
    key = payload.api_key.strip()
    valid = analyzer.validate_api_key(key, payload.model or DEFAULT_MODEL)
    if valid:
        config.set_api_key(key)
        reanalyze_unclassified()
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


def reanalyze_unclassified():
    """Background helper to reanalyze documents with missing person names."""
    key = config.get_api_key()
    if not key:
        return
    docs = database.list_documents()
    for d in docs:
        analysis = d.get("analysis", {})
        # If person_name is empty or doc_type looks like a fallback hash
        if not analysis.get("person_name") or analysis.get("document_type", "").lower() == d.get("doc_id", "").lower():
            file_path = Path(d.get("file_path", ""))
            if file_path.exists():
                try:
                    new_analysis = analyzer.analyze_document(
                        file_path=file_path,
                        mime_type=d.get("mime_type", "image/jpeg"),
                        api_key=key,
                        model_name=DEFAULT_MODEL,
                    )
                    if new_analysis.get("document_type") != file_path.stem.replace("_", " ").title():
                        database.save_document(
                            doc_id=d["doc_id"],
                            original_filename=d["original_filename"],
                            saved_filename=d["saved_filename"],
                            file_path=file_path,
                            mime_type=d.get("mime_type", "image/jpeg"),
                            file_size_bytes=d.get("file_size_bytes", 0),
                            analysis=new_analysis,
                        )
                except Exception as ex:
                    print(f"Reanalysis error for {d['doc_id']}: {ex}")


@app.post("/api/upload")
async def upload_document(
    file: UploadFile = File(...),
    api_key: Optional[str] = Form(None),
    model: Optional[str] = Form(DEFAULT_MODEL),
    x_gemini_key: Optional[str] = Header(None),
):
    """
    Receives an uploaded document/image, analyzes it with Gemini Vision/OCR,
    and stores its classified metadata and file separately.
    """
    # 1. Resolve and persist API key
    if api_key and api_key.strip():
        config.set_api_key(api_key.strip())

    effective_key = (api_key or x_gemini_key or config.get_api_key() or "").strip()

    if not effective_key:
        raise HTTPException(
            status_code=400,
            detail="Gemini API Key is required to analyze this document. Please enter your API key in Settings (⚙️) first.",
        )

    # 2. Determine file extension
    file_ext = Path(file.filename or "").suffix.lower()
    if not file_ext:
        file_ext = ".bin"

    # Generate unique ID and save file
    doc_id = uuid.uuid4().hex[:12]
    saved_filename = f"{doc_id}{file_ext}"
    target_path = DOCUMENTS_DIR / saved_filename

    contents = await file.read()
    file_size = len(contents)

    with open(target_path, "wb") as f:
        f.write(contents)

    # Determine MIME type
    mime_type = file.content_type
    if not mime_type or mime_type == "application/octet-stream":
        mime_type, _ = mimetypes.guess_type(target_path.name)
        if not mime_type:
            mime_type = "image/jpeg"

    # Analyze document with Gemini
    analysis = analyzer.analyze_document(
        file_path=target_path,
        mime_type=mime_type,
        api_key=effective_key,
        model_name=model or DEFAULT_MODEL,
    )

    # Upload to Supabase Bucket if configured & enabled
    sb_info = None
    if supabase_client.get_supabase_config().get("enabled"):
        try:
            sb_info = supabase_client.upload_to_supabase_bucket(
                file_bytes=contents,
                saved_filename=saved_filename,
                mime_type=mime_type,
            )
        except Exception as sb_err:
            print(f"[Supabase] Bucket upload error: {sb_err}")

    # Save to file database and Supabase PostgreSQL table
    saved_record = database.save_document(
        doc_id=doc_id,
        original_filename=file.filename or saved_filename,
        saved_filename=saved_filename,
        file_path=target_path,
        mime_type=mime_type,
        file_size_bytes=file_size,
        analysis=analysis,
        storage_path=sb_info.get("storage_path") if sb_info else None,
        storage_url=sb_info.get("storage_url") if sb_info else None,
    )

    # Strict user requirement: on upload, response is a thumbs up ("👍")
    return {
        "status": "success",
        "message": "👍",
        "doc_id": doc_id,
        "metadata": saved_record,
    }


@app.post("/api/query")
def query_documents(payload: QueryRequest, x_gemini_key: Optional[str] = Header(None)):
    """
    Searches stored documents for the user query.
    If matched, returns the document details directly without conversational filler.
    """
    query = payload.query.strip()
    if not query:
        return {"found": False, "message": "Document not found."}

    effective_key = (payload.api_key or x_gemini_key or config.get_api_key() or "").strip()
    docs = database.list_documents()

    if not docs:
        return {"found": False, "message": "No documents stored yet."}

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
    }


@app.get("/api/documents")
def get_all_documents():
    """Lists all stored documents."""
    return {"documents": database.list_documents()}


@app.get("/api/documents/{doc_id}")
def get_document_details(doc_id: str):
    """Gets metadata of a single document."""
    doc = database.get_document(doc_id)
    if not doc:
        raise HTTPException(status_code=404, detail="Document not found")
    return doc


@app.get("/api/documents/{doc_id}/file")
def get_document_file(doc_id: str, download: bool = False):
    """Streams the document file for preview or download, from local disk or Supabase bucket."""
    doc = database.get_document(doc_id)
    if not doc:
        raise HTTPException(status_code=404, detail="Document not found")

    filename = doc.get("original_filename") or doc.get("saved_filename") or f"{doc_id}.bin"
    mime_type = doc.get("mime_type", "application/octet-stream")
    headers = {}
    if download:
        headers["Content-Disposition"] = f'attachment; filename="{filename}"'

    # 1. Check local file on disk
    local_candidates = []
    if doc.get("file_path"):
        local_candidates.append(Path(doc["file_path"]))
        local_candidates.append(DOCUMENTS_DIR / Path(doc["file_path"]).name)
    if doc.get("saved_filename"):
        local_candidates.append(DOCUMENTS_DIR / doc["saved_filename"])
    if doc.get("doc_id"):
        local_candidates.extend(list(DOCUMENTS_DIR.glob(f"{doc['doc_id']}*")))

    for candidate in local_candidates:
        if candidate and candidate.exists() and candidate.is_file():
            return FileResponse(
                path=candidate,
                media_type=mime_type,
                headers=headers,
            )

    # 2. Check Supabase Storage Bucket
    storage_path = doc.get("storage_path") or f"uploads/{doc.get('saved_filename')}"
    file_bytes = supabase_client.download_from_supabase_bucket(storage_path)
    if file_bytes:
        return Response(
            content=file_bytes,
            media_type=mime_type,
            headers=headers,
        )

    raise HTTPException(status_code=404, detail="Document file missing on disk and Supabase bucket")


@app.delete("/api/documents/{doc_id}")
def remove_document(doc_id: str):
    """Deletes a document and its metadata."""
    success = database.delete_document(doc_id)
    if not success:
        raise HTTPException(status_code=404, detail="Document not found")
    return {"status": "success", "message": f"Document {doc_id} deleted"}
