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
    text: Optional[str] = None,
    attachment_url: Optional[str] = None,
    attachment_type: Optional[str] = None,
    attachment_name: Optional[str] = None,
) -> bool:
    """
    Sends a message reply back to a user via Zernio Unified Inbox API.
    Works for WhatsApp, SMS, and other connected channels.
    Supports file-only delivery (omits text/message payload when text is empty/None).
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
    }

    if text and text.strip():
        payload["message"] = text.strip()
        payload["text"] = text.strip()

    if attachment_url:
        guessed_type = attachment_type or ("image" if any(attachment_url.lower().endswith(ext) for ext in [".png", ".jpg", ".jpeg", ".webp"]) else "file")
        payload["attachmentUrl"] = attachment_url
        payload["attachmentType"] = guessed_type
        if attachment_name:
            payload["attachmentName"] = attachment_name
        payload["attachments"] = [
            {
                "url": attachment_url,
                "type": guessed_type,
                "name": attachment_name or "document",
            }
        ]
        payload["attachment"] = {
            "url": attachment_url,
            "type": guessed_type,
            "name": attachment_name or "document",
        }

    try:
        with httpx.Client(timeout=8.0) as client:
            resp = client.post(url, json=payload, headers=headers)
            _log_event(f"POST {url} status={resp.status_code}", resp.text[:200])
            return resp.status_code in [200, 201, 202]
    except Exception as e:
        _log_event(f"Inbox send error: {e}")
        return False


def find_conversation_by_phone(account_id: str, phone: str) -> Optional[str]:
    """Finds existing conversation for a contact by phone number from Zernio Inbox."""
    api_key = get_zernio_api_key()
    if not api_key or not phone:
        return None
    try:
        clean_phone = phone.replace("+", "").replace(" ", "").replace("-", "")
        with httpx.Client(timeout=5.0) as client:
            resp = client.get(
                f"{ZERNIO_API_BASE}/inbox/conversations",
                params={"accountId": account_id, "limit": 25},
                headers={"Authorization": f"Bearer {api_key}"},
            )
            if resp.status_code == 200:
                convs = resp.json().get("conversations", [])
                for c in convs:
                    contact = c.get("contact") or {}
                    c_phone = str(contact.get("phone") or contact.get("phoneNumber") or c.get("participantId") or "").replace("+", "").replace(" ", "").replace("-", "")
                    if clean_phone and (clean_phone in c_phone or c_phone in clean_phone):
                        return c.get("_id") or c.get("id") or c.get("conversationId")
    except Exception as ex:
        _log_event(f"Error finding conversation by phone: {ex}")
    return None


def send_direct_sms_reply(
    from_phone: str,
    to_phone: str,
    text: Optional[str] = None,
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
    }

    if text and text.strip():
        payload["text"] = text.strip()
    elif media_url:
        payload["text"] = ""

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
    text: Optional[str] = None,
    media_url: Optional[str] = None,
    attachment_type: Optional[str] = None,
    attachment_name: Optional[str] = None,
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
            attachment_type=attachment_type,
            attachment_name=attachment_name,
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
    Supports both WhatsApp and SMS formats, nested and flat schemas,
    dictionary text fields, and image/document attachments.
    """
    _log_event("Webhook received", event_data)

    # Unwrap possible data wrapper
    data = event_data.get("data") if isinstance(event_data.get("data"), dict) else event_data

    event_id = event_data.get("id") or data.get("id")
    event_type = event_data.get("event") or event_data.get("type") or data.get("event") or data.get("type")

    # Handle test webhooks from Zernio dashboard
    if event_type in ["test", "webhook.test", "ping"]:
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
    message_data = data.get("message") or event_data.get("message")
    if not isinstance(message_data, dict):
        message_data = data

    # Ignore outbound messages sent by our bot
    direction = str(message_data.get("direction") or data.get("direction") or event_data.get("direction") or "inbound").lower()
    if direction in ["outbound", "out", "sent"]:
        _log_event(f"Ignoring outbound message echo (direction={direction})")
        return {"status": "ignored", "reason": "outbound_message"}

    # Resolve conversationId
    conversation = data.get("conversation") or event_data.get("conversation") or {}
    if not isinstance(conversation, dict):
        conversation = {}

    conversation_id = (
        conversation.get("conversationId")
        or conversation.get("id")
        or conversation.get("_id")
        or message_data.get("conversationId")
        or message_data.get("conversation_id")
        or message_data.get("id")
        or data.get("conversationId")
        or event_data.get("conversationId")
    )

    # Resolve accountId / profileId
    account = data.get("account") or event_data.get("account") or {}
    if not isinstance(account, dict):
        account = {}

    account_id = (
        account.get("accountId")
        or account.get("id")
        or account.get("_id")
        or account.get("profileId")
        or data.get("accountId")
        or event_data.get("accountId")
        or message_data.get("accountId")
    )
    if not account_id:
        # Default to known WhatsApp account ID if not provided
        account_id = "6adf16ad9c74a0a97edb9b33"

    # Resolve Sender & Recipient Phone Numbers (crucial for SMS and fallback)
    sender_obj = message_data.get("sender") or data.get("sender") or {}
    sender_phone = None
    if isinstance(sender_obj, dict):
        sender_phone = (
            sender_obj.get("phoneNumber")
            or sender_obj.get("phone")
            or sender_obj.get("id")
        )
    elif isinstance(sender_obj, str):
        sender_phone = sender_obj

    contact_obj = conversation.get("contact") or data.get("contact") or {}
    if not sender_phone and isinstance(contact_obj, dict):
        sender_phone = contact_obj.get("phone") or contact_obj.get("phoneNumber") or contact_obj.get("id")

    if not sender_phone:
        sender_phone = message_data.get("from") or data.get("from") or event_data.get("from")

    recipient_obj = message_data.get("recipient") or data.get("recipient") or {}
    recipient_phone = None
    if isinstance(recipient_obj, dict):
        recipient_phone = (
            recipient_obj.get("phoneNumber")
            or recipient_obj.get("phone")
            or recipient_obj.get("id")
        )
    elif isinstance(recipient_obj, str):
        recipient_phone = recipient_obj

    if not recipient_phone:
        recipient_phone = message_data.get("to") or data.get("to") or event_data.get("to")

    # If conversation_id is still missing, attempt lookup by phone from Zernio Inbox
    if not conversation_id and sender_phone and account_id:
        conversation_id = find_conversation_by_phone(account_id, str(sender_phone))
        if conversation_id:
            _log_event(f"Resolved conversation_id from contact phone {sender_phone}: {conversation_id}")

    platform = (
        message_data.get("platform")
        or account.get("platform")
        or conversation.get("platform")
        or data.get("platform")
        or event_data.get("platform")
        or ("sms" if (sender_phone and not conversation_id) else "whatsapp")
    )

    # Extract attachments safely (supports 'attachments' and 'mediaUrls', 'url' and 'mediaUrl')
    raw_attachments = (
        message_data.get("attachments")
        or data.get("attachments")
        or event_data.get("attachments")
        or []
    )
    if not raw_attachments:
        media_urls = message_data.get("mediaUrls") or data.get("mediaUrls") or []
        if media_urls:
            raw_attachments = [{"url": u} for u in media_urls]

    attachments = []
    if isinstance(raw_attachments, list):
        for att in raw_attachments:
            if isinstance(att, dict):
                m_url = att.get("url") or att.get("mediaUrl") or att.get("sourceUrl")
                if m_url:
                    attachments.append({
                        "url": m_url,
                        "type": att.get("contentType") or att.get("mimeType") or att.get("type") or "image/jpeg",
                        "filename": att.get("filename") or att.get("name"),
                    })
            elif isinstance(att, str) and att.startswith("http"):
                attachments.append({"url": att, "type": "image/jpeg", "filename": None})

    # Extract text content safely across WhatsApp/Instagram/SMS schemas
    # WhatsApp often sends {"message": "shivam docs"} or {"text": {"body": "..."}} or {"body": "..."}
    text_content = ""
    raw_text = (
        message_data.get("message")
        or message_data.get("text")
        or message_data.get("body")
        or message_data.get("caption")
        or data.get("message")
        or data.get("text")
        or data.get("body")
        or event_data.get("message")
        or event_data.get("text")
    )
    if isinstance(raw_text, dict):
        text_content = str(raw_text.get("body") or raw_text.get("text") or raw_text.get("message") or "").strip()
    elif isinstance(raw_text, str):
        text_content = raw_text.strip()
    elif raw_text is not None:
        text_content = str(raw_text).strip()

    _log_event(
        f"Parsed message: platform={platform}, conv_id={conversation_id}, "
        f"account_id={account_id}, from={sender_phone}, has_attachments={bool(attachments)}, text='{text_content}'"
    )

    # =========================================================================
    # Case 1: User uploaded document / image attachment
    # =========================================================================
    if attachments:
        processed_count = 0
        api_key = get_zernio_api_key()
        uploaded_summaries = []

        for att in attachments:
            media_url = att.get("url")
            if not media_url:
                continue

            try:
                # 1. Download media bytes (pass auth header if fetching from Zernio, and User-Agent for CDNs)
                dl_headers = {
                    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
                }
                if "zernio.com" in media_url and api_key:
                    dl_headers["Authorization"] = f"Bearer {api_key}"

                with httpx.Client(timeout=10.0, follow_redirects=True) as http_client:
                    media_resp = http_client.get(media_url, headers=dl_headers)
                    if media_resp.status_code != 200:
                        _log_event(f"Failed to download media from {media_url}: status {media_resp.status_code}")
                        continue
                    file_bytes = media_resp.content

                # Correctly resolve real MIME type (must contain '/')
                raw_mime = (
                    att.get("contentType")
                    or att.get("mimeType")
                    or (att.get("payload", {}).get("mimeType") if isinstance(att.get("payload"), dict) else None)
                    or media_resp.headers.get("content-type")
                )
                if not raw_mime or "/" not in str(raw_mime):
                    att_category = str(att.get("type") or "").lower()
                    if att_category in ["image", "photo", "picture"]:
                        raw_mime = "image/jpeg"
                    elif att_category in ["video", "mp4"]:
                        raw_mime = "video/mp4"
                    elif att_category in ["audio", "voice"]:
                        raw_mime = "audio/ogg"
                    elif att_category in ["pdf", "document", "file"]:
                        raw_mime = "application/pdf"
                    else:
                        guessed_m, _ = mimetypes.guess_type(att.get("filename") or "")
                        raw_mime = guessed_m or "image/jpeg"

                mime_type = str(raw_mime).split(";")[0].strip()
                file_ext = mimetypes.guess_extension(mime_type) or (".jpg" if "image" in mime_type else ".pdf")
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
                doc_type = (analysis.get("document_type") or "").strip()
                person = (analysis.get("person_name") or "").strip()
                doc_num = (analysis.get("document_number") or "").strip()
                phone_num = (analysis.get("phone_number") or "").strip()
                dob = (analysis.get("dob") or "").strip()
                authority = (analysis.get("issuing_authority") or "").strip()

                pts = []
                if doc_type and doc_type.lower() != "document":
                    pts.append(f"• Document: {doc_type}")
                if person:
                    pts.append(f"• Name: {person}")
                if doc_num:
                    pts.append(f"• ID No: {doc_num}")
                if phone_num:
                    pts.append(f"• Phone: {phone_num}")
                if dob:
                    pts.append(f"• DOB: {dob}")
                if authority:
                    pts.append(f"• Authority: {authority}")

                if pts:
                    uploaded_summaries.append(pts)

                _log_event(f"Uploaded and indexed: {doc_type} for {person} (doc_id={doc_id})")

            except Exception as ex:
                _log_event(f"Error processing attachment: {ex}")

        if processed_count > 0:
            lines = ["👍\n"]
            for idx, pts in enumerate(uploaded_summaries):
                lines.extend(pts)
                if idx < len(uploaded_summaries) - 1:
                    lines.append("")

            reply_msg = "\n".join(lines).strip()
            send_reply(
                conversation_id=conversation_id,
                account_id=account_id,
                sender_phone=sender_phone,
                recipient_phone=recipient_phone,
                text=reply_msg,
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
                text="Document not found.",
            )
            return {"status": "no_docs_in_vault"}

        matched_doc = analyzer.find_matching_document(
            query=text_content,
            documents=docs,
            api_key=config.get_api_key(),
        )

        if matched_doc:
            doc_id = matched_doc.get("doc_id")
            saved_fname = matched_doc.get("saved_filename") or f"{doc_id}.jpg"
            orig_name = matched_doc.get("original_filename") or saved_fname
            raw_mime = matched_doc.get("mime_type", "")

            # Fix mime_type if it was stored as 'image', 'file', or without '/'
            if not raw_mime or "/" not in str(raw_mime) or raw_mime in ["image", "file", "video"]:
                guessed, _ = mimetypes.guess_type(orig_name) or mimetypes.guess_type(saved_fname)
                mime_type = guessed or "image/jpeg"
            else:
                mime_type = raw_mime

            att_type = "image" if mime_type.startswith("image/") else "file"

            # Use our direct live application URL which streams binary with Content-Type & Content-Disposition
            # This avoids Supabase private bucket 400 errors and Meta crawler rejection
            file_url = f"https://docs-manager-five.vercel.app/api/documents/{doc_id}/file/{saved_fname}"

            _log_event(f"Sending ONLY document file for query '{text_content}': doc_id={doc_id}, mime={mime_type}, att_type={att_type}, url={file_url}")

            # Send strictly ONLY the file — no conversation, paragraph, or text explanation
            send_reply(
                conversation_id=conversation_id,
                account_id=account_id,
                sender_phone=sender_phone,
                recipient_phone=recipient_phone,
                text=None,
                media_url=file_url,
                attachment_type=att_type,
                attachment_name=orig_name,
            )
            return {"status": "matched", "doc_id": doc_id}
        else:
            _log_event(f"No match for query: '{text_content}'")
            send_reply(
                conversation_id=conversation_id,
                account_id=account_id,
                sender_phone=sender_phone,
                recipient_phone=recipient_phone,
                text="Document not found.",
            )
            return {"status": "not_found"}

    return {"status": "noop"}
