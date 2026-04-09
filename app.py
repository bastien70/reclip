import os
import time
import uuid
import glob
import json
import subprocess
import threading
from urllib.parse import unquote

from flask import Flask, request, jsonify, send_file, render_template

app = Flask(__name__)
_BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DOWNLOAD_DIR = os.path.join(_BASE_DIR, "downloads")
SETTINGS_PATH = os.path.join(_BASE_DIR, "settings.json")
os.makedirs(DOWNLOAD_DIR, exist_ok=True)

jobs = {}

_CLEANUP_INTERVAL_SEC = 3600


def _load_settings_raw():
    default = {"auto_delete_days": 0}
    if not os.path.isfile(SETTINGS_PATH):
        return default
    try:
        with open(SETTINGS_PATH, encoding="utf-8") as f:
            data = json.load(f)
        if not isinstance(data, dict):
            return default
        days = data.get("auto_delete_days", 0)
        try:
            days = int(days)
        except (TypeError, ValueError):
            days = 0
        return {"auto_delete_days": max(0, days)}
    except (OSError, json.JSONDecodeError):
        return default


def _save_settings_raw(settings):
    with open(SETTINGS_PATH, "w", encoding="utf-8") as f:
        json.dump(settings, f, indent=2)


def safe_download_path(filename):
    """Resolve filename under DOWNLOAD_DIR; return None if invalid or path traversal."""
    if not filename or not isinstance(filename, str):
        return None
    filename = unquote(filename).strip()
    if not filename or filename in (".", "..") or "\x00" in filename:
        return None
    if os.sep in filename or (os.altsep and os.altsep in filename):
        return None
    if filename.startswith("/"):
        return None
    base = os.path.realpath(DOWNLOAD_DIR)
    candidate = os.path.realpath(os.path.join(DOWNLOAD_DIR, filename))
    if not candidate.startswith(base + os.sep):
        return None
    return candidate


def cleanup_old_downloads():
    """Remove files in DOWNLOAD_DIR older than auto_delete_days (if > 0)."""
    settings = _load_settings_raw()
    days = settings.get("auto_delete_days", 0)
    if days <= 0:
        return
    cutoff = time.time() - (days * 86400)
    try:
        for name in os.listdir(DOWNLOAD_DIR):
            if name.endswith(".meta.json"):
                continue
            path = safe_download_path(name)
            if not path or not os.path.isfile(path):
                continue
            try:
                if os.path.getmtime(path) < cutoff:
                    os.remove(path)
                    meta_path = _meta_path_for(name)
                    if os.path.isfile(meta_path):
                        os.remove(meta_path)
            except OSError:
                pass
    except OSError:
        pass


def cleanup_loop():
    while True:
        time.sleep(_CLEANUP_INTERVAL_SEC)
        try:
            cleanup_old_downloads()
        except Exception:
            pass


def start_cleanup_thread():
    t = threading.Thread(target=cleanup_loop, daemon=True)
    t.start()


def _meta_path_for(media_filename):
    """Return path to the .meta.json sidecar for a given media file."""
    stem = os.path.splitext(media_filename)[0]
    return os.path.join(DOWNLOAD_DIR, stem + ".meta.json")


def _write_meta(job_id, job):
    """Persist metadata alongside the downloaded media file."""
    meta = {
        "title": job.get("title", ""),
        "thumbnail": job.get("thumbnail", ""),
        "uploader": job.get("uploader", ""),
        "duration": job.get("duration"),
        "filename": job.get("filename", ""),
    }
    path = os.path.join(DOWNLOAD_DIR, f"{job_id}.meta.json")
    try:
        with open(path, "w", encoding="utf-8") as f:
            json.dump(meta, f, ensure_ascii=False, indent=2)
    except OSError:
        pass


def _read_meta(media_filename):
    """Read the sidecar .meta.json for a media file; return dict or None."""
    path = _meta_path_for(media_filename)
    if not os.path.isfile(path):
        return None
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, json.JSONDecodeError):
        return None


def run_download(job_id, url, format_choice, format_id):
    job = jobs[job_id]
    out_template = os.path.join(DOWNLOAD_DIR, f"{job_id}.%(ext)s")

    cmd = ["yt-dlp", "--no-playlist", "-o", out_template]

    if format_choice == "audio":
        cmd += ["-x", "--audio-format", "mp3"]
    elif format_id:
        cmd += ["-f", f"{format_id}+bestaudio/best", "--merge-output-format", "mp4"]
    else:
        cmd += ["-f", "bestvideo+bestaudio/best", "--merge-output-format", "mp4"]

    cmd.append(url)

    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=300)
        if result.returncode != 0:
            job["status"] = "error"
            job["error"] = result.stderr.strip().split("\n")[-1]
            return

        files = glob.glob(os.path.join(DOWNLOAD_DIR, f"{job_id}.*"))
        if not files:
            job["status"] = "error"
            job["error"] = "Download completed but no file was found"
            return

        if format_choice == "audio":
            target = [f for f in files if f.endswith(".mp3")]
            chosen = target[0] if target else files[0]
        else:
            target = [f for f in files if f.endswith(".mp4")]
            chosen = target[0] if target else files[0]

        for f in files:
            if f != chosen:
                try:
                    os.remove(f)
                except OSError:
                    pass

        job["status"] = "done"
        job["file"] = chosen
        ext = os.path.splitext(chosen)[1]
        title = job.get("title", "").strip()
        if title:
            safe_title = "".join(c for c in title if c not in r'\/:*?"<>|').strip()[:200].strip()
            job["filename"] = f"{safe_title}{ext}" if safe_title else os.path.basename(chosen)
        else:
            job["filename"] = os.path.basename(chosen)

        _write_meta(job_id, job)
    except subprocess.TimeoutExpired:
        job["status"] = "error"
        job["error"] = "Download timed out (5 min limit)"
    except Exception as e:
        job["status"] = "error"
        job["error"] = str(e)


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/info", methods=["POST"])
def get_info():
    data = request.json
    url = data.get("url", "").strip()
    if not url:
        return jsonify({"error": "No URL provided"}), 400

    cmd = ["yt-dlp", "--no-playlist", "-j", url]
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
        if result.returncode != 0:
            return jsonify({"error": result.stderr.strip().split("\n")[-1]}), 400

        info = json.loads(result.stdout)

        # Build quality options — keep best format per resolution
        best_by_height = {}
        for f in info.get("formats", []):
            height = f.get("height")
            if height and f.get("vcodec", "none") != "none":
                tbr = f.get("tbr") or 0
                if height not in best_by_height or tbr > (best_by_height[height].get("tbr") or 0):
                    best_by_height[height] = f

        formats = []
        for height, f in best_by_height.items():
            formats.append({
                "id": f["format_id"],
                "label": f"{height}p",
                "height": height,
            })
        formats.sort(key=lambda x: x["height"], reverse=True)

        return jsonify({
            "title": info.get("title", ""),
            "thumbnail": info.get("thumbnail", ""),
            "duration": info.get("duration"),
            "uploader": info.get("uploader", ""),
            "formats": formats,
        })
    except subprocess.TimeoutExpired:
        return jsonify({"error": "Timed out fetching video info"}), 400
    except Exception as e:
        return jsonify({"error": str(e)}), 400


@app.route("/api/download", methods=["POST"])
def start_download():
    data = request.json
    url = data.get("url", "").strip()
    format_choice = data.get("format", "video")
    format_id = data.get("format_id")
    title = data.get("title", "")
    thumbnail = data.get("thumbnail", "")
    uploader = data.get("uploader", "")
    duration = data.get("duration")

    if not url:
        return jsonify({"error": "No URL provided"}), 400

    job_id = uuid.uuid4().hex[:10]
    jobs[job_id] = {
        "status": "downloading",
        "url": url,
        "title": title,
        "thumbnail": thumbnail,
        "uploader": uploader,
        "duration": duration,
    }

    thread = threading.Thread(target=run_download, args=(job_id, url, format_choice, format_id))
    thread.daemon = True
    thread.start()

    return jsonify({"job_id": job_id})


@app.route("/api/status/<job_id>")
def check_status(job_id):
    job = jobs.get(job_id)
    if not job:
        return jsonify({"error": "Job not found"}), 404
    return jsonify({
        "status": job["status"],
        "error": job.get("error"),
        "filename": job.get("filename"),
    })


@app.route("/api/file/<job_id>")
def download_file(job_id):
    job = jobs.get(job_id)
    if not job or job["status"] != "done":
        return jsonify({"error": "File not ready"}), 404
    return send_file(job["file"], as_attachment=True, download_name=job["filename"])


@app.route("/api/library", methods=["GET"])
def list_library():
    items = []
    try:
        names = os.listdir(DOWNLOAD_DIR)
    except OSError:
        return jsonify({"files": []})
    for name in names:
        if name.endswith(".meta.json"):
            continue
        path = safe_download_path(name)
        if not path or not os.path.isfile(path):
            continue
        try:
            st = os.stat(path)
        except OSError:
            continue
        ext = os.path.splitext(name)[1].lower().lstrip(".")
        entry = {
            "name": name,
            "size": st.st_size,
            "mtime": int(st.st_mtime),
            "ext": ext,
        }
        meta = _read_meta(name)
        if meta:
            entry["title"] = meta.get("title", "")
            entry["thumbnail"] = meta.get("thumbnail", "")
            entry["uploader"] = meta.get("uploader", "")
            entry["duration"] = meta.get("duration")
            entry["display_name"] = meta.get("filename", "")
        items.append(entry)
    items.sort(key=lambda x: x["mtime"], reverse=True)
    return jsonify({"files": items})


@app.route("/api/library/<filename>", methods=["GET"])
def library_get_file(filename):
    path = safe_download_path(filename)
    if not path or not os.path.isfile(path):
        return jsonify({"error": "File not found"}), 404
    meta = _read_meta(filename)
    dl_name = (meta.get("filename") if meta else None) or os.path.basename(path)
    return send_file(path, as_attachment=True, download_name=dl_name)


@app.route("/api/library/<filename>", methods=["DELETE"])
def library_delete_file(filename):
    path = safe_download_path(filename)
    if not path or not os.path.isfile(path):
        return jsonify({"error": "File not found"}), 404
    try:
        os.remove(path)
    except OSError as e:
        return jsonify({"error": str(e)}), 500
    meta_path = _meta_path_for(filename)
    try:
        if os.path.isfile(meta_path):
            os.remove(meta_path)
    except OSError:
        pass
    return jsonify({"ok": True})


@app.route("/api/settings", methods=["GET"])
def get_settings():
    return jsonify(_load_settings_raw())


@app.route("/api/settings", methods=["POST"])
def post_settings():
    data = request.json or {}
    try:
        days = data.get("auto_delete_days", 0)
        days = int(days)
    except (TypeError, ValueError):
        return jsonify({"error": "auto_delete_days must be a non-negative integer"}), 400
    if days < 0:
        return jsonify({"error": "auto_delete_days must be >= 0"}), 400
    _save_settings_raw({"auto_delete_days": days})
    # Run cleanup once after saving so user sees immediate effect if applicable
    try:
        cleanup_old_downloads()
    except Exception:
        pass
    return jsonify(_load_settings_raw())


if __name__ == "__main__":
    start_cleanup_thread()
    port = int(os.environ.get("PORT", 8899))
    host = os.environ.get("HOST", "127.0.0.1")
    app.run(host=host, port=port)
