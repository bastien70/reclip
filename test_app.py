"""Tests unitaires pour ReClip (pytest).

Pas besoin de yt-dlp ni de réseau : on manipule directement
le dossier downloads/ et les routes Flask via le test client.
"""

import json
import os
import time

import pytest

import app as reclip_app


@pytest.fixture(autouse=True)
def isolated_dirs(tmp_path, monkeypatch):
    """Redirect DOWNLOAD_DIR and SETTINGS_PATH to a temp directory for each test."""
    dl_dir = tmp_path / "downloads"
    dl_dir.mkdir()
    settings_path = tmp_path / "settings.json"

    monkeypatch.setattr(reclip_app, "DOWNLOAD_DIR", str(dl_dir))
    monkeypatch.setattr(reclip_app, "SETTINGS_PATH", str(settings_path))

    reclip_app.jobs.clear()

    yield {
        "downloads": dl_dir,
        "settings": settings_path,
    }


@pytest.fixture()
def client():
    reclip_app.app.config["TESTING"] = True
    with reclip_app.app.test_client() as c:
        yield c


# ---------------------------------------------------------------------------
# Homepage
# ---------------------------------------------------------------------------


def test_homepage(client):
    rv = client.get("/")
    assert rv.status_code == 200
    assert b"ReClip" in rv.data


# ---------------------------------------------------------------------------
# Library – list
# ---------------------------------------------------------------------------


def test_library_empty(client, isolated_dirs):
    rv = client.get("/api/library")
    assert rv.status_code == 200
    data = rv.get_json()
    assert data["files"] == []


def test_library_lists_files(client, isolated_dirs):
    dl = isolated_dirs["downloads"]
    (dl / "abc123.mp4").write_bytes(b"\x00" * 1024)
    time.sleep(0.05)
    (dl / "def456.mp3").write_bytes(b"\x00" * 512)

    rv = client.get("/api/library")
    data = rv.get_json()
    names = [f["name"] for f in data["files"]]
    assert "abc123.mp4" in names
    assert "def456.mp3" in names
    assert data["files"][0]["mtime"] >= data["files"][1]["mtime"]


def test_library_excludes_meta_json(client, isolated_dirs):
    dl = isolated_dirs["downloads"]
    (dl / "abc123.mp4").write_bytes(b"\x00" * 100)
    (dl / "abc123.meta.json").write_text('{"title":"Test"}', encoding="utf-8")

    rv = client.get("/api/library")
    names = [f["name"] for f in rv.get_json()["files"]]
    assert "abc123.mp4" in names
    assert "abc123.meta.json" not in names


def test_library_includes_metadata(client, isolated_dirs):
    dl = isolated_dirs["downloads"]
    (dl / "abc123.mp4").write_bytes(b"\x00" * 100)
    meta = {"title": "My Video", "thumbnail": "https://img.example/thumb.jpg", "filename": "My Video.mp4"}
    (dl / "abc123.meta.json").write_text(json.dumps(meta), encoding="utf-8")

    rv = client.get("/api/library")
    entry = rv.get_json()["files"][0]
    assert entry["title"] == "My Video"
    assert entry["thumbnail"] == "https://img.example/thumb.jpg"
    assert entry["display_name"] == "My Video.mp4"


# ---------------------------------------------------------------------------
# Library – download (GET)
# ---------------------------------------------------------------------------


def test_library_get_file(client, isolated_dirs):
    dl = isolated_dirs["downloads"]
    (dl / "abc123.mp4").write_bytes(b"fakevideo")

    rv = client.get("/api/library/abc123.mp4")
    assert rv.status_code == 200
    assert rv.data == b"fakevideo"
    assert "attachment" in rv.headers.get("Content-Disposition", "")


def test_library_get_file_uses_meta_title(client, isolated_dirs):
    dl = isolated_dirs["downloads"]
    (dl / "abc123.mp4").write_bytes(b"fakevideo")
    meta = {"title": "Cool Title", "filename": "Cool Title.mp4"}
    (dl / "abc123.meta.json").write_text(json.dumps(meta), encoding="utf-8")

    rv = client.get("/api/library/abc123.mp4")
    assert rv.status_code == 200
    assert "Cool Title.mp4" in rv.headers.get("Content-Disposition", "")


def test_library_get_file_not_found(client, isolated_dirs):
    rv = client.get("/api/library/nonexistent.mp4")
    assert rv.status_code == 404


# ---------------------------------------------------------------------------
# Library – path traversal protection
# ---------------------------------------------------------------------------


def test_library_path_traversal_get(client, isolated_dirs):
    rv = client.get("/api/library/..%2F..%2Fetc%2Fpasswd")
    assert rv.status_code == 404


def test_library_path_traversal_delete(client, isolated_dirs):
    rv = client.delete("/api/library/..%2F..%2Fetc%2Fpasswd")
    assert rv.status_code == 404


# ---------------------------------------------------------------------------
# Library – delete
# ---------------------------------------------------------------------------


def test_library_delete_file(client, isolated_dirs):
    dl = isolated_dirs["downloads"]
    media = dl / "abc123.mp4"
    media.write_bytes(b"data")
    meta = dl / "abc123.meta.json"
    meta.write_text('{"title":"x"}', encoding="utf-8")

    rv = client.delete("/api/library/abc123.mp4")
    assert rv.status_code == 200
    assert rv.get_json()["ok"] is True
    assert not media.exists()
    assert not meta.exists()


def test_library_delete_nonexistent(client, isolated_dirs):
    rv = client.delete("/api/library/ghost.mp4")
    assert rv.status_code == 404


# ---------------------------------------------------------------------------
# Settings
# ---------------------------------------------------------------------------


def test_settings_default(client, isolated_dirs):
    rv = client.get("/api/settings")
    assert rv.status_code == 200
    assert rv.get_json()["auto_delete_days"] == 0


def test_settings_save_and_read(client, isolated_dirs):
    rv = client.post("/api/settings", json={"auto_delete_days": 7})
    assert rv.status_code == 200
    assert rv.get_json()["auto_delete_days"] == 7

    rv = client.get("/api/settings")
    assert rv.get_json()["auto_delete_days"] == 7


def test_settings_reject_negative(client, isolated_dirs):
    rv = client.post("/api/settings", json={"auto_delete_days": -1})
    assert rv.status_code == 400


def test_settings_zero_disables(client, isolated_dirs):
    client.post("/api/settings", json={"auto_delete_days": 5})
    rv = client.post("/api/settings", json={"auto_delete_days": 0})
    assert rv.get_json()["auto_delete_days"] == 0


# ---------------------------------------------------------------------------
# Cleanup
# ---------------------------------------------------------------------------


def test_cleanup_removes_old_files(isolated_dirs):
    dl = isolated_dirs["downloads"]
    settings = isolated_dirs["settings"]

    old_file = dl / "old.mp4"
    old_meta = dl / "old.meta.json"
    old_file.write_bytes(b"old")
    old_meta.write_text('{"title":"old"}', encoding="utf-8")
    old_ts = time.time() - (10 * 86400)
    os.utime(str(old_file), (old_ts, old_ts))
    os.utime(str(old_meta), (old_ts, old_ts))

    recent_file = dl / "recent.mp4"
    recent_file.write_bytes(b"new")

    settings.write_text('{"auto_delete_days": 5}', encoding="utf-8")

    reclip_app.cleanup_old_downloads()

    assert not old_file.exists()
    assert not old_meta.exists()
    assert recent_file.exists()


def test_cleanup_noop_when_disabled(isolated_dirs):
    dl = isolated_dirs["downloads"]
    settings = isolated_dirs["settings"]

    old_file = dl / "old.mp4"
    old_file.write_bytes(b"old")
    old_ts = time.time() - (10 * 86400)
    os.utime(str(old_file), (old_ts, old_ts))

    settings.write_text('{"auto_delete_days": 0}', encoding="utf-8")

    reclip_app.cleanup_old_downloads()

    assert old_file.exists()


# ---------------------------------------------------------------------------
# safe_download_path
# ---------------------------------------------------------------------------


def test_safe_path_rejects_dotdot(isolated_dirs):
    assert reclip_app.safe_download_path("../etc/passwd") is None


def test_safe_path_rejects_slash(isolated_dirs):
    assert reclip_app.safe_download_path("/etc/passwd") is None


def test_safe_path_rejects_null_byte(isolated_dirs):
    assert reclip_app.safe_download_path("file\x00.mp4") is None


def test_safe_path_rejects_empty(isolated_dirs):
    assert reclip_app.safe_download_path("") is None
    assert reclip_app.safe_download_path(None) is None


def test_safe_path_accepts_valid(isolated_dirs):
    result = reclip_app.safe_download_path("abc123.mp4")
    assert result is not None
    assert result.endswith("abc123.mp4")


# ---------------------------------------------------------------------------
# Meta read/write helpers
# ---------------------------------------------------------------------------


def test_write_and_read_meta(isolated_dirs):
    job = {"title": "Hello", "thumbnail": "https://x", "uploader": "u", "duration": 42, "filename": "Hello.mp4"}
    reclip_app._write_meta("testid", job)

    meta = reclip_app._read_meta("testid.mp4")
    assert meta is not None
    assert meta["title"] == "Hello"
    assert meta["thumbnail"] == "https://x"
    assert meta["filename"] == "Hello.mp4"


def test_read_meta_missing(isolated_dirs):
    assert reclip_app._read_meta("nonexistent.mp4") is None


# ---------------------------------------------------------------------------
# yt-dlp metadata helpers (library title / thumbnail)
# ---------------------------------------------------------------------------


def test_metadata_from_ytdlp_info_uses_thumbnail_field():
    info = {
        "title": "Hello",
        "thumbnail": "https://cdn.example/thumb.jpg",
        "uploader": "u1",
        "duration": 42,
    }
    m = reclip_app.metadata_from_ytdlp_info(info)
    assert m["title"] == "Hello"
    assert m["thumbnail"] == "https://cdn.example/thumb.jpg"
    assert m["uploader"] == "u1"
    assert m["duration"] == 42


def test_metadata_from_ytdlp_info_picks_best_thumbnails_entry():
    info = {
        "title": "T",
        "thumbnails": [
            {"url": "https://a/small.jpg", "height": 180},
            {"url": "https://a/large.jpg", "height": 720},
        ],
    }
    m = reclip_app.metadata_from_ytdlp_info(info)
    assert m["thumbnail"] == "https://a/large.jpg"


def test_metadata_from_ytdlp_info_non_dict():
    assert reclip_app.metadata_from_ytdlp_info(None) == {}
    assert reclip_app.metadata_from_ytdlp_info("x") == {}


def test_merge_job_from_ytdlp_metadata_fills_empty_only():
    job = {"title": "", "thumbnail": "", "uploader": "", "duration": None}
    meta = {
        "title": "From yt-dlp",
        "thumbnail": "https://x/th.jpg",
        "uploader": "chan",
        "duration": 99,
    }
    reclip_app.merge_job_from_ytdlp_metadata(job, meta)
    assert job["title"] == "From yt-dlp"
    assert job["thumbnail"] == "https://x/th.jpg"
    assert job["uploader"] == "chan"
    assert job["duration"] == 99


def test_merge_job_from_ytdlp_metadata_preserves_client_title():
    job = {"title": "Client title", "thumbnail": "", "uploader": "", "duration": None}
    meta = {"title": "yt-dlp title", "thumbnail": "https://t.jpg", "uploader": "u", "duration": 1}
    reclip_app.merge_job_from_ytdlp_metadata(job, meta)
    assert job["title"] == "Client title"
    assert job["thumbnail"] == "https://t.jpg"


# ---------------------------------------------------------------------------
# Progress parsing
# ---------------------------------------------------------------------------


def test_parse_progress_line_standard():
    pct, txt = reclip_app._parse_progress_line("[download]  42.3% of 12.5MiB at 2.1MiB/s ETA 00:04")
    assert abs(pct - 42.3) < 0.01
    assert "42.3%" in txt
    assert "12.5MiB" in txt


def test_parse_progress_line_100():
    pct, txt = reclip_app._parse_progress_line("[download] 100% of 5.00MiB")
    assert pct == 100.0
    assert "100" in txt


def test_parse_progress_line_approximate_size():
    pct, txt = reclip_app._parse_progress_line("[download]  10.0% of ~50.00MiB at 3.0MiB/s")
    assert abs(pct - 10.0) < 0.01
    assert "50.00MiB" in txt


def test_parse_progress_line_no_match():
    assert reclip_app._parse_progress_line("[info] Extracting URL") is None
    assert reclip_app._parse_progress_line("random text") is None


def test_detect_phase_merger():
    assert reclip_app._detect_phase("[Merger] Merging formats into ...") is not None
    assert "Merging" in reclip_app._detect_phase("[Merger] Merging formats into ...")


def test_detect_phase_ffmpeg():
    result = reclip_app._detect_phase("[ffmpeg] Merging formats into ...")
    assert result is not None
    assert "Merging" in result


def test_detect_phase_extract_audio():
    result = reclip_app._detect_phase("[ExtractAudio] Destination: file.mp3")
    assert result is not None
    assert "Converting" in result


def test_detect_phase_no_match():
    assert reclip_app._detect_phase("[download] 42% of 10MiB") is None
    assert reclip_app._detect_phase("[info] Extracting URL") is None


# ---------------------------------------------------------------------------
# /api/status includes progress fields
# ---------------------------------------------------------------------------


def test_status_returns_progress(client, isolated_dirs):
    reclip_app.jobs["test42"] = {
        "status": "downloading",
        "progress": 55.5,
        "progress_text": "55.5% of 10MiB",
    }
    rv = client.get("/api/status/test42")
    data = rv.get_json()
    assert data["status"] == "downloading"
    assert data["progress"] == 55.5
    assert data["progress_text"] == "55.5% of 10MiB"


def test_status_done_has_progress_100(client, isolated_dirs):
    reclip_app.jobs["done1"] = {
        "status": "done",
        "progress": 100,
        "progress_text": "100%",
        "filename": "video.mp4",
    }
    rv = client.get("/api/status/done1")
    data = rv.get_json()
    assert data["progress"] == 100
    assert data["filename"] == "video.mp4"


# ---------------------------------------------------------------------------
# /api/cancel
# ---------------------------------------------------------------------------


def test_cancel_unknown_job(client):
    rv = client.post("/api/cancel/notarealid")
    assert rv.status_code == 404


def test_cancel_already_finished(client, isolated_dirs):
    reclip_app.jobs["fin1"] = {"status": "done", "filename": "x.mp4"}
    rv = client.post("/api/cancel/fin1")
    assert rv.status_code == 200
    assert rv.get_json()["already"] == "done"


def test_cancel_sets_flag_on_downloading_job(client, isolated_dirs):
    reclip_app.jobs["dl1"] = {"status": "downloading", "proc": None}
    rv = client.post("/api/cancel/dl1")
    assert rv.status_code == 200
    assert rv.get_json()["ok"] is True
    assert reclip_app.jobs["dl1"]["cancelled"] is True


# ---------------------------------------------------------------------------
# CORS (browser extension)
# ---------------------------------------------------------------------------


EXT_ORIGIN = "chrome-extension://abcdefghijklmnopqrstuvwxyz123456"


def test_cors_preflight_options(client):
    rv = client.open(
        "/api/download",
        method="OPTIONS",
        headers={"Origin": EXT_ORIGIN},
    )
    assert rv.status_code == 204
    assert rv.headers.get("Access-Control-Allow-Origin") == EXT_ORIGIN
    assert "POST" in (rv.headers.get("Access-Control-Allow-Methods") or "")


def test_cors_get_library(client, isolated_dirs):
    rv = client.get(
        "/api/library",
        headers={"Origin": EXT_ORIGIN},
    )
    assert rv.status_code == 200
    assert rv.headers.get("Access-Control-Allow-Origin") == EXT_ORIGIN


def test_cors_not_applied_to_non_extension_origin(client, isolated_dirs):
    rv = client.get(
        "/api/library",
        headers={"Origin": "http://example.com"},
    )
    assert rv.status_code == 200
    assert rv.headers.get("Access-Control-Allow-Origin") is None
