"""GitRepo shadow-checkpoint plumbing: create_checkpoint / checkpoint_diff /
restore_to / prune_checkpoints.

The crux under test: every one of these ops must run against a THROWAWAY
`GIT_INDEX_FILE`, never the user's real `.git/index`, and must never move
HEAD or the current branch. Each test proves this directly against a real
temp git repo built with plain `git` subprocess calls (never via GitRepo
itself, so the fixture doesn't presuppose the code under test).
"""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

import pytest
from sanad_terminal.git_ops import GitError, GitRepo, _checkpoint_ref

pytestmark = pytest.mark.skipif(shutil.which("git") is None, reason="git not installed")

CID = "c_" + "a" * 12
TURN_1 = "t_" + "1" * 12
TURN_2 = "t_" + "2" * 12
TURN_3 = "t_" + "3" * 12


def _git(root: Path, *args: str) -> str:
    res = subprocess.run(
        ["git", "-C", str(root), *args],
        check=True,
        capture_output=True,
        text=True,
    )
    return res.stdout


def _seed_repo(root: Path) -> tuple[str, str]:
    """A real repo with one commit on HEAD (a.txt + b.txt). Returns
    (head_sha, branch) — the baseline every test asserts is undisturbed."""
    root.mkdir(parents=True, exist_ok=True)
    _git(root, "init", "-q", "-b", "main")
    _git(root, "config", "user.name", "Test User")
    _git(root, "config", "user.email", "test@example.com")
    (root / "a.txt").write_text("one\n")
    (root / "b.txt").write_text("two\n")
    _git(root, "add", "-A")
    _git(root, "commit", "-q", "-m", "seed")
    head = _git(root, "rev-parse", "HEAD").strip()
    branch = _git(root, "symbolic-ref", "--short", "HEAD").strip()
    return head, branch


def _head(root: Path) -> str:
    return _git(root, "rev-parse", "HEAD").strip()


def _branch(root: Path) -> str:
    return _git(root, "symbolic-ref", "--short", "HEAD").strip()


def _status(root: Path) -> str:
    return _git(root, "status", "--porcelain")


def _ref_exists(root: Path, ref: str) -> bool:
    res = subprocess.run(
        ["git", "-C", str(root), "rev-parse", "--verify", "--quiet", ref],
        capture_output=True,
        text=True,
    )
    return res.returncode == 0


@pytest.fixture
def repo(tmp_path: Path) -> Path:
    return tmp_path / "repo"


# --------------------------------------------------------------------------
# create_checkpoint
# --------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_create_checkpoint_commits_off_head_tree_without_moving_head(repo: Path):
    head, branch = _seed_repo(repo)
    (repo / "a.txt").write_text("one\nedited\n")  # uncommitted, real-index untouched
    status_before = _status(repo)

    git = GitRepo(repo)
    ref = _checkpoint_ref(CID, TURN_1, "pre")
    sha = await git.create_checkpoint(ref, "pre-turn checkpoint")

    assert sha is not None and sha != head
    # HEAD, branch, and the real index/worktree status: untouched.
    assert _head(repo) == head
    assert _branch(repo) == branch
    assert _status(repo) == status_before
    # The checkpoint ref exists and points at a commit capturing the edit.
    assert _ref_exists(repo, f"refs/sanad/checkpoints/{ref}")
    show = _git(repo, "show", f"{sha}:a.txt")
    assert show == "one\nedited\n"
    # Parentless: this was the first checkpoint for this turn.
    parents = _git(repo, "log", "-1", "--format=%P", sha).strip()
    assert parents == ""


@pytest.mark.asyncio
async def test_create_checkpoint_never_touches_the_real_git_index_bytes(repo: Path):
    """Byte-level lock on the throwaway-GIT_INDEX_FILE discipline this whole
    module documents — stronger than the `git status` check the other tests
    use (which only proves the reported porcelain lines match, not that the
    index file itself was never written to): snapshot `.git/index`'s raw
    bytes before/after a representative checkpoint op and assert byte-for-
    byte equality."""
    _seed_repo(repo)
    index_path = repo / ".git" / "index"
    assert index_path.is_file()
    index_before = index_path.read_bytes()

    git = GitRepo(repo)
    (repo / "a.txt").write_text("one\nedited\n")  # uncommitted, real index untouched
    ref = _checkpoint_ref(CID, TURN_1, "pre")
    sha = await git.create_checkpoint(ref, "byte-level index check")

    assert sha is not None
    assert index_path.read_bytes() == index_before


@pytest.mark.asyncio
async def test_second_checkpoint_chains_as_child_of_parent(repo: Path):
    head, branch = _seed_repo(repo)
    git = GitRepo(repo)

    ref1 = _checkpoint_ref(CID, TURN_1, "pre")
    sha1 = await git.create_checkpoint(ref1, "checkpoint 1")
    assert sha1 is not None

    (repo / "a.txt").write_text("one\nsecond edit\n")
    status_before = _status(repo)  # captured AFTER the edit, right before the op under test
    ref2 = _checkpoint_ref(CID, TURN_1, "post")
    sha2 = await git.create_checkpoint(ref2, "checkpoint 2", parent=sha1)
    assert sha2 is not None and sha2 != sha1

    parents = _git(repo, "log", "-1", "--format=%P", sha2).strip()
    assert parents == sha1

    assert _head(repo) == head
    assert _branch(repo) == branch
    assert _status(repo) == status_before


@pytest.mark.asyncio
async def test_create_checkpoint_skips_and_returns_none_when_tree_unchanged(repo: Path):
    _seed_repo(repo)
    git = GitRepo(repo)

    ref1 = _checkpoint_ref(CID, TURN_1, "pre")
    sha1 = await git.create_checkpoint(ref1, "checkpoint 1")
    assert sha1 is not None

    # No edits at all — the tree is identical to the parent's.
    ref2 = _checkpoint_ref(CID, TURN_1, "post")
    sha2 = await git.create_checkpoint(ref2, "checkpoint 2", parent=sha1)

    assert sha2 is None
    assert not _ref_exists(repo, f"refs/sanad/checkpoints/{ref2}")
    # The kept ref (ref1) is of course still there.
    assert _ref_exists(repo, f"refs/sanad/checkpoints/{ref1}")


@pytest.mark.asyncio
async def test_create_checkpoint_captures_a_new_untracked_file(repo: Path):
    head, branch = _seed_repo(repo)
    (repo / "new_file.txt").write_text("brand new\n")  # untracked, never `git add`ed
    status_before = _status(repo)
    git = GitRepo(repo)

    ref = _checkpoint_ref(CID, TURN_1, "pre")
    sha = await git.create_checkpoint(ref, "captures untracked")

    assert sha is not None
    listed = _git(repo, "ls-tree", "-r", "--name-only", sha)
    assert "new_file.txt" in listed.splitlines()
    assert _git(repo, "show", f"{sha}:new_file.txt") == "brand new\n"

    assert _head(repo) == head
    assert _branch(repo) == branch
    assert _status(repo) == status_before


@pytest.mark.asyncio
async def test_create_checkpoint_rejects_a_malformed_ref(repo: Path):
    _seed_repo(repo)
    git = GitRepo(repo)
    with pytest.raises(GitError) as exc:
        await git.create_checkpoint("../../etc/passwd", "bad")
    assert exc.value.code == "invalid_ref"


def test_checkpoint_ref_rejects_malformed_components():
    with pytest.raises(GitError):
        _checkpoint_ref("not-a-cid", TURN_1, "pre")
    with pytest.raises(GitError):
        _checkpoint_ref(CID, "not-a-turn-id", "pre")
    with pytest.raises(GitError):
        _checkpoint_ref(CID, TURN_1, "../escape")


# --------------------------------------------------------------------------
# checkpoint_diff
# --------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_checkpoint_diff_between_two_checkpoints(repo: Path):
    head, branch = _seed_repo(repo)
    git = GitRepo(repo)

    ref1 = _checkpoint_ref(CID, TURN_1, "pre")
    sha1 = await git.create_checkpoint(ref1, "cp1")
    assert sha1 is not None

    (repo / "a.txt").write_text("one\ntwo\n")  # modify
    (repo / "c.txt").write_text("c-content\n")  # add
    status_before = _status(repo)

    ref2 = _checkpoint_ref(CID, TURN_1, "post")
    sha2 = await git.create_checkpoint(ref2, "cp2", parent=sha1)
    assert sha2 is not None

    result = await git.checkpoint_diff(sha1, sha2, max_bytes=1_000_000)

    by_path = {e["path"]: e["status"] for e in result["nameStatus"]}
    assert by_path == {"a.txt": "M", "c.txt": "A"}
    assert result["filesChanged"] == 2
    assert result["additions"] == 2  # +1 line in a.txt, +1 line (new) in c.txt
    assert result["deletions"] == 0
    assert result["truncated"] is False
    assert "+two" in result["patch"]
    assert "c-content" in result["patch"]

    assert _head(repo) == head
    assert _branch(repo) == branch
    assert _status(repo) == status_before


@pytest.mark.asyncio
async def test_checkpoint_diff_truncates_patch_at_max_bytes(repo: Path):
    _seed_repo(repo)
    git = GitRepo(repo)
    ref1 = _checkpoint_ref(CID, TURN_1, "pre")
    sha1 = await git.create_checkpoint(ref1, "cp1")
    assert sha1 is not None

    (repo / "a.txt").write_text("one\ntwo\nthree\nfour\nfive\n")
    ref2 = _checkpoint_ref(CID, TURN_1, "post")
    sha2 = await git.create_checkpoint(ref2, "cp2", parent=sha1)
    assert sha2 is not None

    result = await git.checkpoint_diff(sha1, sha2, max_bytes=10)

    assert result["truncated"] is True
    assert len(result["patch"].encode("utf-8")) <= 10
    # Counts still reflect the real diff, not the truncated patch text.
    assert result["filesChanged"] == 1


@pytest.mark.asyncio
async def test_checkpoint_diff_against_worktree_reflects_uncommitted_edit(repo: Path):
    head, branch = _seed_repo(repo)
    git = GitRepo(repo)
    ref1 = _checkpoint_ref(CID, TURN_1, "pre")
    sha1 = await git.create_checkpoint(ref1, "cp1")
    assert sha1 is not None

    (repo / "a.txt").write_text("one\nuncommitted change\n")  # never checkpointed
    status_before = _status(repo)

    result = await git.checkpoint_diff(sha1, None, max_bytes=1_000_000)

    by_path = {e["path"]: e["status"] for e in result["nameStatus"]}
    assert by_path == {"a.txt": "M"}
    assert "uncommitted change" in result["patch"]

    assert _head(repo) == head
    assert _branch(repo) == branch
    assert _status(repo) == status_before


@pytest.mark.asyncio
async def test_checkpoint_diff_name_status_unescapes_unicode_paths(repo: Path):
    """`--name-status` must run with `-z`: plain (non -z) output would return
    the core.quotePath-escaped form (`"caf\\303\\251.txt"`) for a unicode
    filename, which would break per-file matching in the /diff route + UI
    that key off `nameStatus[].path`."""
    head, branch = _seed_repo(repo)
    git = GitRepo(repo)
    ref1 = _checkpoint_ref(CID, TURN_1, "pre")
    sha1 = await git.create_checkpoint(ref1, "cp1")
    assert sha1 is not None

    (repo / "café.txt").write_text("bonjour\n")
    ref2 = _checkpoint_ref(CID, TURN_1, "post")
    sha2 = await git.create_checkpoint(ref2, "cp2", parent=sha1)
    assert sha2 is not None
    status_before = _status(repo)

    result = await git.checkpoint_diff(sha1, sha2, max_bytes=1_000_000)

    by_path = {e["path"]: e["status"] for e in result["nameStatus"]}
    assert by_path == {"café.txt": "A"}

    assert _head(repo) == head
    assert _branch(repo) == branch
    assert _status(repo) == status_before


@pytest.mark.asyncio
async def test_checkpoint_diff_rejects_non_hex_refs(repo: Path):
    _seed_repo(repo)
    git = GitRepo(repo)
    with pytest.raises(GitError) as exc:
        await git.checkpoint_diff("main", None, max_bytes=1000)
    assert exc.value.code == "invalid_ref"


# --------------------------------------------------------------------------
# restore_to
# --------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_restore_to_restores_modified_recreates_deleted_removes_added(repo: Path):
    head, branch = _seed_repo(repo)  # a.txt=one, b.txt=two, committed
    git = GitRepo(repo)

    # Checkpoint a target state: a.txt edited, b.txt untouched, c.txt added.
    (repo / "a.txt").write_text("one\nEDIT1\n")
    (repo / "c.txt").write_text("c-content\n")
    ref = _checkpoint_ref(CID, TURN_1, "pre")
    target_sha = await git.create_checkpoint(ref, "target")
    assert target_sha is not None

    # Now drift further away from the target: modify a.txt again, delete
    # b.txt, and add a file that was never part of the target.
    (repo / "a.txt").write_text("one\nEDIT1\nEDIT2\n")
    (repo / "b.txt").unlink()
    (repo / "d.txt").write_text("d-content\n")

    await git.restore_to(target_sha)

    assert (repo / "a.txt").read_text() == "one\nEDIT1\n"  # modified -> restored
    assert (repo / "b.txt").read_text() == "two\n"  # deleted -> recreated
    assert (repo / "c.txt").read_text() == "c-content\n"  # unrelated file untouched
    assert not (repo / "d.txt").exists()  # added after target -> removed

    # HEAD/branch never moved.
    assert _head(repo) == head
    assert _branch(repo) == branch
    # The real index/HEAD still reflect the ORIGINAL commit (a=one, b=two);
    # b.txt's restored content is byte-identical to what's committed, so it
    # reports clean, while a.txt (content changed relative to HEAD) and
    # c.txt (never committed) show up exactly as they would with a real
    # index that was never touched by restore_to.
    status_lines = {line for line in _status(repo).splitlines() if line.strip()}
    assert status_lines == {" M a.txt", "?? c.txt"}


@pytest.mark.asyncio
async def test_restore_to_removes_special_char_filenames(repo: Path):
    """Regression test for the -z fix: `ls-files`/`ls-tree --name-only`
    without `-z` return a core.quotePath-escaped string for a filename with
    a space/unicode char, which never matches a real on-disk path, so the
    removal in restore_to would silently no-op for exactly this case."""
    head, branch = _seed_repo(repo)  # a.txt=one, b.txt=two, committed
    git = GitRepo(repo)

    ref = _checkpoint_ref(CID, TURN_1, "pre")
    target_sha = await git.create_checkpoint(ref, "target")  # tree == a.txt/b.txt only
    assert target_sha is not None

    # A file with BOTH a space and a unicode character, plus an ordinary
    # later file — both were added AFTER the target and must be removed.
    (repo / "a café.txt").write_text("special\n")
    (repo / "later.txt").write_text("later\n")

    await git.restore_to(target_sha)

    assert not (repo / "a café.txt").exists()
    assert not (repo / "later.txt").exists()
    # Target files are untouched.
    assert (repo / "a.txt").read_text() == "one\n"
    assert (repo / "b.txt").read_text() == "two\n"

    assert _head(repo) == head
    assert _branch(repo) == branch


@pytest.mark.asyncio
async def test_restore_to_handles_nested_subdirectory_paths(repo: Path):
    """Exercises `_remove_worktree_relpath`'s containment join on a NESTED
    path, and `checkout-index` recreating leading directories that don't
    exist yet in the worktree."""
    head, branch = _seed_repo(repo)  # a.txt=one, b.txt=two, committed
    git = GitRepo(repo)

    nested = repo / "sub" / "dir"
    nested.mkdir(parents=True)
    (nested / "file.txt").write_text("nested-one\n")

    ref = _checkpoint_ref(CID, TURN_1, "pre")
    target_sha = await git.create_checkpoint(ref, "target")  # captures sub/dir/file.txt too
    assert target_sha is not None

    # (a) modify the nested file after the checkpoint.
    (nested / "file.txt").write_text("nested-one\nEDITED\n")
    # (b) add a new nested file after the checkpoint.
    (nested / "new.txt").write_text("brand new nested\n")

    await git.restore_to(target_sha)

    assert (nested / "file.txt").read_text() == "nested-one\n"  # (a) restored
    assert not (nested / "new.txt").exists()  # (b) removed — exactly it
    assert (repo / "a.txt").read_text() == "one\n"  # unrelated files untouched
    assert (repo / "b.txt").read_text() == "two\n"

    assert _head(repo) == head
    assert _branch(repo) == branch


@pytest.mark.asyncio
async def test_restore_to_does_not_follow_or_delete_a_symlink_escaping_root(
    repo: Path, tmp_path: Path
):
    """Regression test for the highest-risk destructive branch, previously
    unexercised: restore_to's removal phase (`_remove_worktree_relpath`)
    resolves each delete-candidate path and only unlinks it when the
    RESOLVED path stays under root — this is what stops a symlink sitting
    in the worktree from making the destructive delete phase follow it out
    of the repo and remove a file elsewhere on disk. Plants a real symlink
    pointing at a real file outside root, added AFTER the checkpointed
    target (so it's exactly the kind of path restore_to's second phase
    tries to remove), and locks that the outside file survives untouched
    and `.git/` (HEAD/branch) is undisturbed."""
    head, branch = _seed_repo(repo)  # a.txt=one, b.txt=two, committed
    git = GitRepo(repo)

    ref = _checkpoint_ref(CID, TURN_1, "pre")
    target_sha = await git.create_checkpoint(ref, "target")  # tree == a.txt/b.txt only
    assert target_sha is not None

    outside = tmp_path / "outside_secret.txt"
    outside.write_text("do not touch\n")
    evil = repo / "evil"
    evil.symlink_to(outside)  # added AFTER the checkpoint -> a delete candidate

    await git.restore_to(target_sha)

    # The REAL file outside root must survive — never followed, never deleted.
    assert outside.exists()
    assert outside.read_text() == "do not touch\n"
    # Target files untouched.
    assert (repo / "a.txt").read_text() == "one\n"
    assert (repo / "b.txt").read_text() == "two\n"
    # .git/ itself: untouched — HEAD/branch never moved.
    assert _head(repo) == head
    assert _branch(repo) == branch
    assert (repo / ".git").is_dir()


@pytest.mark.asyncio
async def test_restore_to_rejects_non_hex_tree_ish(repo: Path):
    _seed_repo(repo)
    git = GitRepo(repo)
    with pytest.raises(GitError) as exc:
        await git.restore_to("not-a-sha")
    assert exc.value.code == "invalid_ref"


# --------------------------------------------------------------------------
# prune_checkpoints
# --------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_prune_checkpoints_deletes_only_non_kept_refs(repo: Path):
    head, branch = _seed_repo(repo)
    status_before = _status(repo)
    git = GitRepo(repo)

    refs = {}
    for turn in (TURN_1, TURN_2, TURN_3):
        ref = _checkpoint_ref(CID, turn, "pre")
        sha = await git.create_checkpoint(ref, f"checkpoint for {turn}")
        assert sha is not None
        refs[turn] = ref

    # A checkpoint under a DIFFERENT conversation must never be touched.
    other_cid = "c_" + "b" * 12
    other_ref = _checkpoint_ref(other_cid, TURN_1, "pre")
    other_sha = await git.create_checkpoint(other_ref, "other conversation")
    assert other_sha is not None

    await git.prune_checkpoints(CID, keep_turn_ids=[TURN_2])

    assert not _ref_exists(repo, f"refs/sanad/checkpoints/{refs[TURN_1]}")
    assert _ref_exists(repo, f"refs/sanad/checkpoints/{refs[TURN_2]}")
    assert not _ref_exists(repo, f"refs/sanad/checkpoints/{refs[TURN_3]}")
    assert _ref_exists(repo, f"refs/sanad/checkpoints/{other_ref}")

    assert _head(repo) == head
    assert _branch(repo) == branch
    assert _status(repo) == status_before
