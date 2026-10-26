import os
import uuid
import mimetypes
from typing import Any, Dict, List, Optional
from datetime import datetime, timezone
import httpx

from backend import config, database, analyzer, supabase_client

ZERNIO_API_BASE = "https://api.zernio.com/v1"
_processed_events = set()
_recent_webhook_logs: List[Dict[str, Any]] = []


def get_zernio_api_key() -> str:
    """Reads Zernio API key from config or environment."""
    return config.get_zernio_api_key()


def get_recent_webhook_logs() -> List[Dict[str, Any]]:
    """Returns the last 20 webhook events received for debugging."""
    return _recent_webhook_logs[-20:]


def _log_event(summary: str, details: Any = None):
    """Logs recent webhook actions."""
    entry = {
        "time": datetime.now(timezone.utc).isoformat(),
        "summary": summary,
        "details": details,
    }
    _recent_webhook_logs.append(entry)
    if len(_recent_webhook_logs) > 50:
        _recent_webhook_logs.pop(0)
    print(f"[Zernio] {summary}")


def send_conversation_reply(
    conversation_id: str,
    account_id: str,
    text: str,
    attachment_url: Optional[str] = None,
) -> bool:
    """
    Sends a message reply back to a user via Zernio Unified Inbox API.
    Works for WhatsApp, SMS, and other connected channels.
    """
    api_key = get_zernio_api_key()
    if not api_key:
        _log_event("Cannot send reply: ZERNIO_API_KEY is missing")
        return False

    url = f"{ZERNIO_API_BASE}/inbox/conversations/{conversation_id}/messages"
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }

    payload: Dict[str, Any] = {
        "accountId": account_id,
        "message": text,
    }

    if attachment_url:
        payload["attachment"] = {
            "url": attachment_url,
        }

    try:
        with httpx.Client(timeout=8.0) as client:
            resp = client.post(url, json=payload, headers=headers)
            _log_event(f"POST {url} status={resp.status_code}", resp.text[:200])
            if resp.status_code in [200, 201, 202]:
                return True
            else:
                return False
    except Exception as e:
        _log_event(f"Inbox send error: {e}")
        return False


def send_direct_sms_reply(
    from_phone: str,
    to_phone: str,
    text: str,
    media_url: Optional[str] = None,
) -> bool:
    """
    Direct SMS sending endpoint (POST /v1/sms/messages).
    Used as an immediate fallback when a user contacts via SMS.
    """
    api_key = get_zernio_api_key()
    if not api_key or not to_phone or not from_phone:
        return False

    url = f"{ZERNIO_API_BASE}/sms/messages"
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }

    payload: Dict[str, Any] = {
        "from": from_phone,
        "to": to_phone,
        "text": text,
    }

    if media_url:
        payload["mediaUrls"] = [media_url]

    try:
        with httpx.Client(timeout=8.0) as client:
            resp = client.post(url, json=payload, headers=headers)
            _log_event(f"POST SMS status={resp.status_code}", resp.text[:200])
            return resp.status_code in [200, 201, 202]
    except Exception as e:
        _log_event(f"Direct SMS send error: {e}")
        return False


def send_reply(
    conversation_id: Optional[str],
    account_id: Optional[str],
    sender_phone: Optional[str],
    recipient_phone: Optional[str],
    text: str,
    media_url: Optional[str] = None,
) -> bool:
    """
    Robust dual-channel reply:
    1. Tries Unified Inbox (supports WhatsApp & threaded SMS).
    2. If conversation reply fails or is missing, falls back to direct SMS.
    """
    success = False
    if conversation_id and account_id:
        success = send_conversation_reply(
            conversation_id=conversation_id,
            account_id=account_id,
            text=text,
            attachment_url=media_url,
        )

    # Fallback to direct SMS if conversation failed and phone numbers are present
    if not success and sender_phone and recipient_phone:
        _log_event(f"Falling back to direct SMS send from {recipient_phone} to {sender_phone}")
        success = send_direct_sms_reply(
            from_phone=recipient_phone,
            to_phone=sender_phone,
            text=text,
            media_url=media_url,
        )

    return success


def process_incoming_zernio_event(event_data: Dict[str, Any]) -> Dict[str, Any]:
    """
    Processes incoming Zernio webhook events.
    Supports both WhatsApp and SMS formats, nested and flat schemas.
    """
    _log_event("Webhook received", event_data)

    event_id = event_data.get("id")
    event_type = event_data.get("event") or event_data.get("type")

    # Handle test webhooks from Zernio dashboard
    if event_type in ["test", "webhook.test"]:
        _log_event("Zernio test event acknowledged")
        return {"status": "success", "message": "Test webhook verified"}

    # Deduplicate repeated deliveries
    if event_id:
        if event_id in _processed_events:
            _log_event(f"Skipping duplicate event_id: {event_id}")
            return {"status": "skipped", "reason": "already_processed"}
        _processed_events.add(event_id)
        if len(_processed_events) > 1000:
            _processed_events.clear()

    # Extract message object (nested in 'message' or at root)
    message_data = event_data.get("message")
    if not isinstance(message_data, dict):
        message_data = event_data

    # Ignore outbound messages sent by our bot
    direction = message_data.get("direction", "inbound")
    if direction == "outbound":
        _log_event("Ignoring outbound message echo")
        return {"status": "ignored", "reason": "outbound_message"}

    # Resolve conversationId
    conversation = event_data.get("conversation", {})
    conversation_id = (
        conversation.get("conversationId")
        or message_data.get("conversationId")
        or event_data.get("conversationId")
    )

    # Resolve accountId / profileId
    account = event_data.get("account", {})
    account_id = (
        account.get("accountId")
        or account.get("profileId")
        or event_data.get("accountId")
        or message_data.get("accountId")
    )

    # Resolve Sender & Recipient Phone Numbers (crucial for SMS and fallback)
    sender_obj = message_data.get("sender", {})
    sender_phone = (
        (sender_obj.get("phoneNumber") if isinstance(sender_obj, dict) else None)
        or (sender_obj.get("id") if isinstance(sender_obj, dict) else None)
        or message_data.get("from")
        or event_data.get("from")
    )

    recipient_obj = message_data.get("recipient", {})
    recipient_phone = (
        (recipient_obj.get("phoneNumber") if isinstance(recipient_obj, dict) else None)
        or (recipient_obj.get("id") if isinstance(recipient_obj, dict) else None)
        or message_data.get("to")
        or event_data.get("to")
    )

    platform = (
        message_data.get("platform")
        or conversation.get("platform")
        or ("sms" if (sender_phone and not conversation_id) else "whatsapp")
    )

    # Extract attachments and text
    attachments = message_data.get("attachments", [])
    if not attachments and message_data.get("mediaUrls"):
        attachments = [{"url": u} for u in message_data.get("mediaUrls", [])]

    text_content = (message_data.get("text") or message_data.get("body") or "").strip()

    _log_event(
        f"Parsed message: platform={platform}, conv_id={conversation_id}, "
        f"from={sender_phone}, has_attachments={bool(attachments)}, text='{text_content}'"
    )

    # =========================================================================
    # Case 1: User uploaded document / image attachment
    # =========================================================================
    if attachments:
        processed_count = 0
        for att in attachments:
            media_url = att.get("url")
            if not media_url:
                continue

            try:
                # 1. Download media bytes
                with httpx.Client(timeout=10.0) as http_client:
                    media_resp = http_client.get(media_url)
                    if media_resp.status_code != 200:
                        _log_event(f"Failed to download media from {media_url}: status {media_resp.status_code}")
                        continue
                    file_bytes = media_resp.content

                mime_type = att.get("type") or media_resp.headers.get("content-type") or "image/jpeg"
                file_ext = mimetypes.guess_extension(mime_type) or ".jpg"
                doc_id = uuid.uuid4().hex[:12]
                saved_filename = f"{doc_id}{file_ext}"
                filename = att.get("filename") or f"{platform}_{saved_filename}"

                # 2. AI Multimodal OCR analysis directly in memory
                analysis = analyzer.analyze_document(
                    file_bytes=file_bytes,
                    mime_type=mime_type,
                    filename=filename,
                    api_key=config.get_api_key(),
                )

                # 3. Store file in Supabase Storage Bucket
                sb_info = supabase_client.upload_to_supabase_bucket(
                    file_bytes=file_bytes,
                    saved_filename=saved_filename,
                    mime_type=mime_type,
                )

                # 4. Save metadata to Supabase DB
                database.save_document(
                    doc_id=doc_id,
                    original_filename=filename,
                    saved_filename=saved_filename,
                    mime_type=mime_type,
                    file_size_bytes=len(file_bytes),
                    analysis=analysis,
                    storage_path=sb_info["storage_path"],
                    storage_url=sb_info.get("storage_url"),
                )

                processed_count += 1
                doc_type = analysis.get("document_type", "Document")
                person = analysis.get("person_name", "")
                _log_event(f"Uploaded and indexed: {doc_type} for {person} (doc_id={doc_id})")

            except Exception as ex:
                _log_event(f"Error processing attachment: {ex}")

        if processed_count > 0:
            send_reply(
                conversation_id=conversation_id,
                account_id=account_id,
                sender_phone=sender_phone,
                recipient_phone=recipient_phone,
                text="👍",
            )
            return {"status": "uploaded", "count": processed_count}
        else:
            send_reply(
                conversation_id=conversation_id,
                account_id=account_id,
                sender_phone=sender_phone,
                recipient_phone=recipient_phone,
                text="⚠️ Could not process the uploaded file. Please send a clear photo or PDF.",
            )
            return {"status": "failed", "reason": "attachment_processing_failed"}

    # =========================================================================
    # Case 2: Natural Language Query (user asking for a document)
    # =========================================================================
    if text_content:
        docs = database.list_documents()
        if not docs:
            send_reply(
                conversation_id=conversation_id,
                account_id=account_id,
                sender_phone=sender_phone,
                recipient_phone=recipient_phone,
                text="No documents have been stored in the vault yet. Upload an ID or document first!",
            )
            return {"status": "no_docs_in_vault"}

        matched_doc = analyzer.find_matching_document(
            query=text_content,
            documents=docs,
            api_key=config.get_api_key(),
        )

        if matched_doc:
            doc_id = matched_doc.get("doc_id")
            analysis = matched_doc.get("analysis", {})
            doc_type = analysis.get("document_type", "Document")
            person_name = analysis.get("person_name", "")
            doc_num = analysis.get("document_number", "")
            summary = analysis.get("short_summary", "")
            file_url = matched_doc.get("storage_url") or ""

            lines = [f"📄 *{doc_type}*"]
            if person_name:
                lines.append(f"👤 Name: {person_name}")
            if doc_num:
                lines.append(f"🔢 ID: {doc_num}")
            if summary:
                lines.append(f"ℹ️ {summary}")
            if file_url:
                lines.append(f"\n🔗 View / Download:\n{file_url}")

            reply_msg = "\n".join(lines)
            _log_event(f"Replying match for query '{text_content}': doc_id={doc_id}")

            send_reply(
                conversation_id=conversation_id,
                account_id=account_id,
                sender_phone=sender_phone,
                recipient_phone=recipient_phone,
                text=reply_msg,
                media_url=file_url if file_url else None,
            )
            return {"status": "matched", "doc_id": doc_id}
        else:
            _log_event(f"No match for query: '{text_content}'")
            send_reply(
                conversation_id=conversation_id,
                account_id=account_id,
                sender_phone=sender_phone,
                recipient_phone=recipient_phone,
                text="Document not found. Please specify the person's name or document type (e.g. 'Give me Shivam's Aadhar card').",
            )
            return {"status": "not_found"}

    return {"status": "noop"}
