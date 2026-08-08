import io
import zipfile
from pathlib import Path

import pytest
from sanad_terminal import workspace_fs as wfs


@pytest.fixture
def root(tmp_path: Path) -> Path:
    ws = tmp_path / "workspace"
    ws.mkdir()
    (ws / "docs").mkdir()
    (ws / "docs" / "readme.md").write_text("# hi\n")
    (ws / "main.py").write_text("print('hi')\n")
    return ws


# -- resolve_safe: the security core ------------------------------------------


@pytest.mark.parametrize(
    "bad",
    ["/etc/passwd", "//x", "../outside", "a/../../outside", "docs/../../x", "..", "a/.."],
)
def test_traversal_and_absolute_rejected(root: Path, bad: str):
    with pytest.raises(wfs.PathViolation):
        wfs.resolve_safe(root, bad)


def test_symlink_escape_rejected(root: Path, tmp_path: Path):
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "secret.txt").write_text("s")
    (root / "link").symlink_to(outside)
    with pytest.raises(wfs.PathViolation):
        wfs.resolve_safe(root, "link/secret.txt")


def test_symlink_file_escape_rejected(root: Path, tmp_path: Path):
    secret = tmp_path / "kimi-share" / "config.toml"
    secret.parent.mkdir()
    secret.write_text("token")
    (root / "cfg").symlink_to(secret)
    with pytest.raises(wfs.PathViolation):
        wfs.resolve_safe(root, "cfg")


def test_happy_paths(root: Path):
    assert wfs.resolve_safe(root, "") == root.resolve()
    assert wfs.resolve_safe(root, ".") == root.resolve()
    assert wfs.resolve_safe(root, "docs/readme.md") == (root / "docs" / "readme.md").resolve()
    assert wfs.resolve_safe(root, "new/sub/file.txt") == (root / "new/sub/file.txt").resolve()


# -- operations ----------------------------------------------------------------


def test_list_dir_sorted_dirs_first(root: Path):
    entries = wfs.list_dir(root, "")
    assert [(e.kind, e.name) for e in entries] == [("dir", "docs"), ("file", "main.py")]
    assert entries[1].size == len("print('hi')\n")


def test_list_dir_skips_heavy_dirs(root: Path):
    (root / "node_modules").mkdir()
    (root / ".git").mkdir()
    names = [e.name for e in wfs.list_dir(root, "")]
    assert "node_modules" not in names
    assert ".git" not in names


def test_snapshot_recursive_and_bounded(root: Path):
    entries, truncated = wfs.snapshot(root)
    paths = {e.path for e in entries}
    assert {"docs", "docs/readme.md", "main.py"} <= paths
    assert truncated is False

    for i in range(10):
        (root / f"f{i}.txt").write_text("x")
    limited, truncated = wfs.snapshot(root, max_entries=5)
    assert len(limited) == 5
    assert truncated is True


def test_write_read_mkdir_delete_move(root: Path):
    entry = wfs.write_file(root, "notes/todo.txt", b"do it")
    assert entry.path == "notes/todo.txt"
    assert wfs.file_for_read(root, "notes/todo.txt").read_bytes() == b"do it"

    made = wfs.make_dir(root, "assets/img")
    assert made.kind == "dir"
    with pytest.raises(wfs.AlreadyExists):
        wfs.make_dir(root, "assets/img")

    moved = wfs.move(root, "notes/todo.txt", "assets/todo.txt")
    assert moved.path == "assets/todo.txt"
    with pytest.raises(wfs.NotFound):
        wfs.file_for_read(root, "notes/todo.txt")
    with pytest.raises(wfs.AlreadyExists):
        wfs.move(root, "main.py", "assets/todo.txt")

    wfs.delete(root, "assets")
    with pytest.raises(wfs.NotFound):
        wfs.list_dir(root, "assets")


def test_delete_root_refused(root: Path):
    with pytest.raises(wfs.PathViolation):
        wfs.delete(root, "")


def test_search_case_insensitive_bounded(root: Path):
    results = wfs.search(root, "README")
    assert [e.path for e in results] == ["docs/readme.md"]
    assert wfs.search(root, "") == []


def test_sanitize_filename():
    assert wfs.sanitize_filename("report.pdf") == "report.pdf"
    assert wfs.sanitize_filename("../../evil.sh") == "evil.sh"
    assert wfs.sanitize_filename("a\\b\\c.txt") == "c.txt"
    with pytest.raises(wfs.PathViolation):
        wfs.sanitize_filename("..")


def test_sanitize_preserves_names_exactly():
    # Spaces, parens, unicode — kept verbatim (the uploaded name IS the name).
    assert wfs.sanitize_filename("My Report (final) v2.pdf") == "My Report (final) v2.pdf"
    assert wfs.sanitize_filename(" leading and trailing ") == " leading and trailing "
    assert wfs.sanitize_filename("تقرير نهائي.pdf") == "تقرير نهائي.pdf"


def test_sanitize_repairs_latin1_mojibake():
    original = "تقرير.pdf"
    mojibake = original.encode("utf-8").decode("latin-1")
    assert wfs.sanitize_filename(mojibake) == original


def test_zip_directory_and_whole_workspace(root: Path):
    spool = wfs.build_zip(root, "docs")
    with zipfile.ZipFile(io.BytesIO(spool.read())) as zf:
        assert zf.namelist() == ["docs/readme.md"]
    spool.close()

    spool = wfs.build_zip(root, "")
    with zipfile.ZipFile(io.BytesIO(spool.read())) as zf:
        assert sorted(zf.namelist()) == ["docs/readme.md", "main.py"]
    spool.close()


def test_zip_skips_symlinks(root: Path, tmp_path: Path):
    outside = tmp_path / "outside.txt"
    outside.write_text("secret")
    (root / "docs" / "leak").symlink_to(outside)
    spool = wfs.build_zip(root, "docs")
    with zipfile.ZipFile(io.BytesIO(spool.read())) as zf:
        assert zf.namelist() == ["docs/readme.md"]
    spool.close()


# -- archive_list: list zip/tar members without extracting ---------------------


def test_archive_list_zip(root: Path):
    p = root / "bundle.zip"
    with zipfile.ZipFile(p, "w") as zf:
        zf.writestr("a.txt", "hello")
        zf.writestr("dir/b.txt", "world!")
    entries, truncated = wfs.archive_list(root, "bundle.zip")
    assert not truncated
    by_name = {e.name: e for e in entries}
    assert "a.txt" in by_name and by_name["a.txt"].size == 5 and not by_name["a.txt"].is_dir
    assert "dir/b.txt" in by_name and by_name["dir/b.txt"].size == 6


def test_archive_list_targz(root: Path):
    import io
    import tarfile

    data = b"hello world"
    with tarfile.open(root / "bundle.tar.gz", "w:gz") as tf:
        info = tarfile.TarInfo("x.txt")
        info.size = len(data)
        tf.addfile(info, io.BytesIO(data))
    entries, _ = wfs.archive_list(root, "bundle.tar.gz")
    assert any(e.name == "x.txt" and e.size == len(data) for e in entries)


def test_archive_list_truncates(root: Path):
    with zipfile.ZipFile(root / "many.zip", "w") as zf:
        for i in range(5):
            zf.writestr(f"f{i}.txt", "x")
    entries, truncated = wfs.archive_list(root, "many.zip", max_entries=3)
    assert truncated and len(entries) == 3


def test_archive_list_rejects_non_archive(root: Path):
    with pytest.raises(wfs.UnsupportedArchive):
        wfs.archive_list(root, "main.py")
