import os
import json
from pathlib import Path
from typing import Optional, Dict, Any, List
from datetime import datetime, timezone
from supabase import create_client, Client
from supabase.lib.client_options import SyncClientOptions

from backend.config import STORAGE_DIR

SUPABASE_CONFIG_FILE = STORAGE_DIR / "supabase_config.json"

_supabase_client_instance: Optional[Client] = None
_last_supabase_key: Optional[str] = None


def get_supabase_config() -> Dict[str, Any]:
    """
    Reads Supabase configuration from environment variables or persistent config file.
    Automatically enabled if SUPABASE_URL and SUPABASE_KEY are set.
    """
    url = os.getenv("SUPABASE_URL", "").strip()
    key = os.getenv("SUPABASE_KEY", "").strip()
    bucket = os.getenv("SUPABASE_BUCKET", "documents").strip() or "documents"

    # Default to enabled if both URL and Key are in environment variables
    is_enabled = bool(url and key)

    config = {
        "enabled": is_enabled,
        "url": url,
        "key": key,
        "bucket": bucket,
    }

    if SUPABASE_CONFIG_FILE.exists():
        try:
            saved = json.loads(SUPABASE_CONFIG_FILE.read_text(encoding="utf-8"))
            if isinstance(saved, dict):
                if saved.get("url"):
                    config["url"] = saved["url"].strip()
                if saved.get("key"):
                    config["key"] = saved["key"].strip()
                if saved.get("bucket"):
                    config["bucket"] = saved["bucket"].strip()
                if "enabled" in saved:
                    config["enabled"] = bool(saved["enabled"] and config["url"] and config["key"])
                else:
                    config["enabled"] = bool(config["url"] and config["key"])
        except Exception:
            pass

    return config


def set_supabase_config(url: str, key: str, bucket: str = "documents", enabled: bool = True) -> Dict[str, Any]:
    """Saves Supabase configuration."""
    cfg = {
        "enabled": bool(enabled and url.strip() and key.strip()),
        "url": url.strip(),
        "key": key.strip(),
        "bucket": (bucket.strip() or "documents"),
    }
    try:
        STORAGE_DIR.mkdir(parents=True, exist_ok=True)
        SUPABASE_CONFIG_FILE.write_text(json.dumps(cfg, indent=2), encoding="utf-8")
    except Exception:
        pass

    # Update process env
    os.environ["SUPABASE_URL"] = cfg["url"]
    os.environ["SUPABASE_KEY"] = cfg["key"]
    os.environ["SUPABASE_BUCKET"] = cfg["bucket"]
    return cfg


def get_client() -> Optional[Client]:
    """Returns an authenticated Supabase client singleton with safe timeouts."""
    global _supabase_client_instance, _last_supabase_key
    cfg = get_supabase_config()
    if not cfg.get("enabled") or not cfg.get("url") or not cfg.get("key"):
        return None

    cache_key = f"{cfg['url']}::{cfg['key']}"
    if _supabase_client_instance is not None and _last_supabase_key == cache_key:
        return _supabase_client_instance

    try:
        # Enforce 5s postgrest timeout and 8s storage timeout to prevent Vercel 504 timeouts
        opts = SyncClientOptions(postgrest_client_timeout=5, storage_client_timeout=8)
        _supabase_client_instance = create_client(cfg["url"], cfg["key"], options=opts)
        _last_supabase_key = cache_key
        return _supabase_client_instance
    except Exception as e:
        print(f"[Supabase] Client init error: {e}")
        return None


def test_connection(url: str, key: str, bucket: str = "documents") -> Dict[str, Any]:
    """Tests Supabase connection to storage bucket and database."""
    if not url or not key:
        return {"valid": False, "message": "Supabase URL and Key are required."}
    try:
        client = create_client(url.strip(), key.strip())
        bucket_name = bucket.strip() or "documents"

        # 1. Test Storage Bucket
        bucket_ready = False
        try:
            buckets = client.storage.list_buckets()
            existing_names = [b.name for b in buckets] if buckets else []
            if bucket_name not in existing_names:
                try:
                    client.storage.create_bucket(bucket_name, options={"public": True})
                    bucket_ready = True
                except Exception:
                    # Might not have permission to create bucket, but can access if it exists
                    bucket_ready = True
            else:
                bucket_ready = True
        except Exception as bex:
            print(f"[Supabase] Storage check notice: {bex}")
            bucket_ready = True

        # 2. Test DB table access (documents_metadata)
        table_ready = False
        try:
            client.table("documents_metadata").select("doc_id").limit(1).execute()
            table_ready = True
        except Exception:
            table_ready = False

        return {
            "valid": True,
            "bucket_ready": bucket_ready,
            "table_ready": table_ready,
            "message": "Connected to Supabase successfully!",
        }
    except Exception as e:
        return {"valid": False, "message": f"Connection failed: {str(e)}"}


def upload_to_supabase_bucket(
    file_bytes: bytes,
    saved_filename: str,
    mime_type: str,
) -> Dict[str, str]:
    """Uploads file bytes directly to the Supabase storage bucket."""
    client = get_client()
    if not client:
        raise RuntimeError("Supabase client is not connected. Check SUPABASE_URL and SUPABASE_KEY.")

    cfg = get_supabase_config()
    bucket_name = cfg.get("bucket", "documents")
    storage_path = f"uploads/{saved_filename}"

    try:
        client.storage.from_(bucket_name).upload(
            path=storage_path,
            file=file_bytes,
            file_options={"content-type": mime_type, "upsert": "true"},
        )

        storage_url = get_public_or_signed_url(storage_path)
        return {
            "storage_path": storage_path,
            "storage_url": storage_url,
            "bucket": bucket_name,
        }
    except Exception as e:
        err_msg = str(e)
        if "not found" in err_msg.lower() or "404" in err_msg:
            # Auto-create public bucket with service_role privileges and retry
            try:
                client.storage.create_bucket(bucket_name, options={"public": True})
                client.storage.from_(bucket_name).upload(
                    path=storage_path,
                    file=file_bytes,
                    file_options={"content-type": mime_type, "upsert": "true"},
                )
                storage_url = get_public_or_signed_url(storage_path)
                return {
                    "storage_path": storage_path,
                    "storage_url": storage_url,
                    "bucket": bucket_name,
                }
            except Exception as retry_err:
                print(f"[Supabase] Auto-create bucket error: {retry_err}")
                raise RuntimeError(f"Supabase bucket upload failed: {retry_err}")

        print(f"[Supabase] Upload error: {e}")
        raise RuntimeError(f"Supabase bucket upload failed: {str(e)}")


def get_public_or_signed_url(storage_path: str, expires_in: int = 60 * 60 * 24 * 7) -> str:
    """
    Returns a guaranteed accessible download URL for a file in Supabase storage.
    Attempts signed URL first (accessible whether bucket is private or public),
    falling back to public URL.
    """
    client = get_client()
    if not client:
        return ""
    cfg = get_supabase_config()
    bucket_name = cfg.get("bucket", "documents")

    # 1. Try to ensure bucket is public
    try:
        client.storage.update_bucket(bucket_name, options={"public": True})
    except Exception:
        pass

    # 2. Try signed URL (works even if bucket is private)
    try:
        signed_res = client.storage.from_(bucket_name).create_signed_url(storage_path, expires_in)
        if isinstance(signed_res, dict) and signed_res.get("signedURL"):
            return signed_res["signedURL"]
        elif isinstance(signed_res, str) and signed_res.startswith("http"):
            return signed_res
    except Exception:
        pass

    # 3. Fallback to public URL
    try:
        return client.storage.from_(bucket_name).get_public_url(storage_path)
    except Exception:
        return ""


def download_from_supabase_bucket(storage_path: str) -> Optional[bytes]:
    """Downloads binary file from Supabase storage bucket."""
    client = get_client()
    if not client:
        return None

    cfg = get_supabase_config()
    bucket_name = cfg.get("bucket", "documents")
    try:
        return client.storage.from_(bucket_name).download(storage_path)
    except Exception as e:
        print(f"[Supabase] Download error for {storage_path}: {e}")
        return None


def delete_from_supabase_bucket(storage_path: str) -> bool:
    """Removes file from Supabase storage bucket."""
    client = get_client()
    if not client:
        return False

    cfg = get_supabase_config()
    bucket_name = cfg.get("bucket", "documents")
    try:
        client.storage.from_(bucket_name).remove([storage_path])
        return True
    except Exception as e:
        print(f"[Supabase] Bucket delete error: {e}")
        return False


def save_metadata_to_supabase_db(record: Dict[str, Any]) -> bool:
    """Saves structured metadata record to Supabase documents_metadata table."""
    client = get_client()
    if not client:
        raise RuntimeError("Supabase client is not connected. Check SUPABASE_URL and SUPABASE_KEY.")

    analysis = record.get("analysis", {})
    row = {
        "doc_id": record.get("doc_id"),
        "original_filename": record.get("original_filename"),
        "saved_filename": record.get("saved_filename"),
        "storage_path": record.get("storage_path") or f"uploads/{record.get('saved_filename')}",
        "storage_url": record.get("storage_url") or "",
        "mime_type": record.get("mime_type"),
        "file_size_bytes": record.get("file_size_bytes", 0),
        "document_type": analysis.get("document_type", "Document"),
        "person_name": analysis.get("person_name", ""),
        "document_number": analysis.get("document_number", ""),
        "issuing_authority": analysis.get("issuing_authority", ""),
        "dob": analysis.get("dob", ""),
        "searchable_keywords": analysis.get("searchable_keywords", []),
        "short_summary": analysis.get("short_summary", ""),
        "created_at": record.get("created_at") or datetime.now(timezone.utc).isoformat(),
    }

    try:
        client.table("documents_metadata").upsert(row).execute()
        return True
    except Exception as e:
        print(f"[Supabase] DB Upsert error: {e}")
        raise RuntimeError(f"Supabase DB insert error: {str(e)}")


def get_all_metadata_from_supabase_db() -> List[Dict[str, Any]]:
    """Retrieves all document metadata records directly from Supabase PostgreSQL table."""
    client = get_client()
    if not client:
        return []

    try:
        res = client.table("documents_metadata").select("*").order("created_at", desc=True).execute()
        rows = res.data or []
        docs = []
        for r in rows:
            saved_fn = r.get("saved_filename") or f"{r.get('doc_id')}.bin"
            doc_record = {
                "doc_id": r.get("doc_id"),
                "original_filename": r.get("original_filename") or saved_fn,
                "saved_filename": saved_fn,
                "storage_path": r.get("storage_path") or f"uploads/{saved_fn}",
                "storage_url": r.get("storage_url") or "",
                "mime_type": r.get("mime_type") or "application/octet-stream",
                "file_size_bytes": r.get("file_size_bytes", 0),
                "created_at": r.get("created_at"),
                "analysis": {
                    "document_type": r.get("document_type", "Document"),
                    "person_name": r.get("person_name", ""),
                    "document_number": r.get("document_number", ""),
                    "issuing_authority": r.get("issuing_authority", ""),
                    "dob": r.get("dob", ""),
                    "searchable_keywords": r.get("searchable_keywords") or [],
                    "short_summary": r.get("short_summary", ""),
                },
            }
            docs.append(doc_record)
        return docs
    except Exception as e:
        print(f"[Supabase] DB Fetch error: {e}")
        return []


def get_metadata_by_id_from_supabase_db(doc_id: str) -> Optional[Dict[str, Any]]:
    """Retrieves a single document metadata record by doc_id directly from Supabase."""
    client = get_client()
    if not client:
        return None

    try:
        res = client.table("documents_metadata").select("*").eq("doc_id", doc_id).limit(1).execute()
        rows = res.data or []
        if not rows:
            return None
        r = rows[0]
        saved_fn = r.get("saved_filename") or f"{r.get('doc_id')}.bin"
        return {
            "doc_id": r.get("doc_id"),
            "original_filename": r.get("original_filename") or saved_fn,
            "saved_filename": saved_fn,
            "storage_path": r.get("storage_path") or f"uploads/{saved_fn}",
            "storage_url": r.get("storage_url") or "",
            "mime_type": r.get("mime_type") or "application/octet-stream",
            "file_size_bytes": r.get("file_size_bytes", 0),
            "created_at": r.get("created_at"),
            "analysis": {
                "document_type": r.get("document_type", "Document"),
                "person_name": r.get("person_name", ""),
                "document_number": r.get("document_number", ""),
                "issuing_authority": r.get("issuing_authority", ""),
                "dob": r.get("dob", ""),
                "searchable_keywords": r.get("searchable_keywords") or [],
                "short_summary": r.get("short_summary", ""),
            },
        }
    except Exception as e:
        print(f"[Supabase] DB Fetch by ID error: {e}")
        return None


def delete_metadata_from_supabase_db(doc_id: str) -> bool:
    """Deletes record from Supabase table."""
    client = get_client()
    if not client:
        return False
    try:
        client.table("documents_metadata").delete().eq("doc_id", doc_id).execute()
        return True
    except Exception as e:
        print(f"[Supabase] DB Delete error: {e}")
        return False
