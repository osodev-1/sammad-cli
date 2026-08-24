"""Git operations for the workspace — a thin, safe wrapper over the git binary.

Runs git inside the user's workspace root, as the agent's unprivileged user
when one is configured (uid split), so repository files keep the same
ownership the PTY agent writes. Every invocation pins ``safe.directory`` (the
EFS access point maps ownership to uid 1000 regardless of writer, which git
would otherwise flag as "dubious ownership") and never inherits ambient git
config.

This module shells out; it does not import a git library. Output is parsed
from porcelain formats chosen for stability.
"""

from __future__ import annotations

import asyncio
import contextlib
import os
import re
import tempfile
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path

# The checkpoint ref namespace lives entirely OUTSIDE refs/heads — it is
# never checked out, never merged, and never visible to `git branch`.
_CHECKPOINTS_NS = "refs/sanad/checkpoints/"

# Mirrors CONVERSATION_ID_RE (coder_runner.py) and the `t_<12 hex>` shape
# minted for turn ids (wire_runner.py). Duplicated here rather than imported
# so this low-level primitive stays free of a dependency on the runner
# layer; both must be kept in sync if either shape ever changes.
_CID_RE = re.compile(r"^c_[a-f0-9]{12}$")
_TURN_ID_RE = re.compile(r"^t_[a-f0-9]{12}$")
_CHECKPOINT_KIND_RE = re.compile(r"^(pre|post|safety-\d+)$")

# The full `<cid>/<turnId>-<kind>` shape a checkpoint ref suffix must match —
# validated again inside create_checkpoint() itself (defense in depth: a
# caller could pass a ref string that never went through _checkpoint_ref()).
_CHECKPOINT_SUFFIX_RE = re.compile(r"^c_[a-f0-9]{12}/t_[a-f0-9]{12}-(pre|post|safety-\d+)$")
_CHECKPOINT_SUFFIX_PART_RE = re.compile(r"^(?P<turn_id>t_[a-f0-9]{12})-(?:pre|post|safety-\d+)$")

# commit-tree needs an author + committer identity, but the scratch env
# carries no git config (never inherits ambient config) — set one directly.
_CHECKPOINT_IDENTITY = {
    "GIT_AUTHOR_NAME": "sanad",
    "GIT_AUTHOR_EMAIL": "checkpoints@sanadcode.com",
    "GIT_COMMITTER_NAME": "sanad",
    "GIT_COMMITTER_EMAIL": "checkpoints@sanadcode.com",
}


class GitError(Exception):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


@dataclass
class GitStatus:
    is_repo: bool
    branch: str | None = None
    head: str | None = None  # short SHA
    ahead: int = 0
    behind: int = 0
    staged: list[str] = field(default_factory=list)
    unstaged: list[str] = field(default_factory=list)
    untracked: list[str] = field(default_factory=list)

    @property
    def dirty_count(self) -> int:
        return len(self.staged) + len(self.unstaged) + len(self.untracked)


def _preexec(uid: int | None, gid: int | None) -> Callable[[], None] | None:
    if uid is None and gid is None:
        return None

    def _run() -> None:
        if gid is not None:
            os.setgid(gid)
        if uid is not None:
            os.setuid(uid)

    return _run


class GitRepo:
    """Bound to one workspace root; runs git there with a fixed identity."""

    def __init__(
        self,
        root: Path,
        *,
        uid: int | None = None,
        gid: int | None = None,
        home: Path | None = None,
    ) -> None:
        self._root = root
        self._uid = uid
        self._gid = gid
        self._home = home

    async def _run(
        self, *args: str, check: bool = True, extra_env: dict[str, str] | None = None
    ) -> tuple[int, str, str]:
        base = [
            "git",
            "-C",
            str(self._root),
            "-c",
            f"safe.directory={self._root}",
        ]
        env = {
            "GIT_TERMINAL_PROMPT": "0",  # never block on credential prompts
            "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
            "HOME": str(self._home) if self._home else str(self._root),
        }
        if extra_env:
            # e.g. GIT_INDEX_FILE (throwaway-index discipline) or the
            # commit-tree author/committer identity — layered on top of the
            # base env, never replacing it.
            env.update(extra_env)
        proc = await asyncio.create_subprocess_exec(
            *base,
            *args,
            cwd=str(self._root),
            env=env,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            preexec_fn=_preexec(self._uid, self._gid),
        )
        out, err = await proc.communicate()
        rc = proc.returncode or 0
        if check and rc != 0:
            raise GitError(
                "git_failed", err.decode("utf-8", "replace").strip() or f"git exited {rc}"
            )
        return rc, out.decode("utf-8", "replace"), err.decode("utf-8", "replace")

    async def is_repo(self) -> bool:
        rc, out, _ = await self._run("rev-parse", "--is-inside-work-tree", check=False)
        return rc == 0 and out.strip() == "true"

    async def _current_branch(self) -> str | None:
        # symbolic-ref reports the branch even on an UNBORN HEAD (fresh init,
        # no commits yet), where rev-parse --abbrev-ref returns the literal
        # "HEAD". It fails only on a truly detached HEAD.
        rc, out, _ = await self._run("symbolic-ref", "--short", "HEAD", check=False)
        if rc == 0 and out.strip():
            return out.strip()
        return None

    async def ensure_repo(self) -> None:
        if await self.is_repo():
            await self._ensure_cache_ignored()
            return
        await self._run("init", "-b", "main")
        # A default local identity so the first commit never fails; the commit
        # endpoint overrides author/committer per call from the signed-in user.
        await self._run("config", "user.name", "Sanad Workspace")
        await self._run("config", "user.email", "workspace@sanadcode.com")
        await self._ensure_cache_ignored()

    async def _ensure_cache_ignored(self) -> None:
        """The blueprint's disposable cache (transaction records, graph index)
        must never enter history — auto-commit on apply would otherwise sweep
        it in with every change."""
        ignore = self._root / ".gitignore"
        line = ".sanad/.cache/"
        try:
            existing = ignore.read_text(encoding="utf-8") if ignore.exists() else ""
            if line not in existing.split("\n"):
                joiner = "" if existing.endswith("\n") or not existing else "\n"
                ignore.write_text(existing + joiner + line + "\n", encoding="utf-8")
        except OSError:
            pass  # unignorable cache is cosmetic, never fatal

    async def status(self) -> GitStatus:
        if not await self.is_repo():
            return GitStatus(is_repo=False)

        branch = await self._current_branch()
        _, head_out, _ = await self._run("rev-parse", "--short", "HEAD", check=False)
        head = head_out.strip() or None

        ahead = behind = 0
        rc, ab_out, _ = await self._run(
            "rev-list", "--left-right", "--count", "@{upstream}...HEAD", check=False
        )
        if rc == 0 and ab_out.strip():
            parts = ab_out.split()
            if len(parts) == 2:
                behind, ahead = int(parts[0]), int(parts[1])

        staged: list[str] = []
        unstaged: list[str] = []
        untracked: list[str] = []
        _, porc, _ = await self._run("status", "--porcelain=v1", "-z", check=False)
        for entry in porc.split("\0"):
            if not entry:
                continue
            code = entry[:2]
            path = entry[3:]
            if code == "??":
                untracked.append(path)
                continue
            if code[0] not in (" ", "?"):
                staged.append(path)
            if code[1] not in (" ", "?"):
                unstaged.append(path)

        return GitStatus(
            is_repo=True,
            branch=branch,
            head=head,
            ahead=ahead,
            behind=behind,
            staged=staged,
            unstaged=unstaged,
            untracked=untracked,
        )

    async def branches(self) -> tuple[str | None, list[str]]:
        await self.ensure_repo()
        _, out, _ = await self._run(
            "for-each-ref", "--format=%(refname:short)", "refs/heads", check=False
        )
        names = [line.strip() for line in out.splitlines() if line.strip()]
        current = await self._current_branch()
        # A fresh unborn branch has no ref yet — surface it so the UI shows it.
        if current and current not in names:
            names.insert(0, current)
        return current, names

    async def create_branch(self, name: str) -> None:
        _validate_branch(name)
        await self.ensure_repo()
        # -c requires at least one commit; fall back to switch --orphan-free path.
        rc, _, err = await self._run("switch", "-c", name, check=False)
        if rc != 0:
            raise GitError("branch_failed", err.strip() or "could not create branch")

    async def checkout(self, name: str) -> None:
        _validate_branch(name)
        rc, _, err = await self._run("switch", name, check=False)
        if rc != 0:
            # A dirty tree makes git refuse the switch — surface it distinctly so
            # the UI can offer commit/stash/discard (WC-007).
            if "local changes" in err.lower() or "overwritten" in err.lower():
                raise GitError("dirty_tree", "Commit, stash, or discard changes before switching")
            raise GitError("checkout_failed", err.strip() or "could not switch branch")

    async def stage_all(self) -> None:
        await self._run("add", "-A")

    async def commit(self, message: str, author_name: str, author_email: str) -> str:
        await self.ensure_repo()
        await self.stage_all()
        rc, out, err = await self._run(
            "-c",
            f"user.name={author_name}",
            "-c",
            f"user.email={author_email}",
            "commit",
            "-m",
            message,
            check=False,
        )
        if rc != 0:
            # git prints "nothing to commit" to STDOUT, other errors to STDERR.
            combined = (out + err).lower()
            if "nothing to commit" in combined or "no changes added" in combined:
                raise GitError("nothing_to_commit", "There are no changes to commit")
            raise GitError("commit_failed", err.strip() or out.strip() or "commit failed")
        _, head, _ = await self._run("rev-parse", "--short", "HEAD", check=False)
        return head.strip()

    async def commit_paths(
        self, paths: list[str], message: str, author_name: str, author_email: str
    ) -> str:
        """Commit ONLY the given pathspecs — the blueprint auto-commit must
        never sweep the user's unrelated workspace edits into its history."""
        await self.ensure_repo()
        await self._run("add", "-A", "--", *paths)
        rc, out, err = await self._run(
            "-c",
            f"user.name={author_name}",
            "-c",
            f"user.email={author_email}",
            "commit",
            "-m",
            message,
            "--",
            *paths,
            check=False,
        )
        if rc != 0:
            combined = (out + err).lower()
            if "nothing to commit" in combined or "no changes added" in combined:
                raise GitError("nothing_to_commit", "There are no changes to commit")
            raise GitError("commit_failed", err.strip() or out.strip() or "commit failed")
        _, head, _ = await self._run("rev-parse", "--short", "HEAD", check=False)
        return head.strip()

    async def log(self, limit: int = 50, path: str | None = None) -> list[dict[str, str]]:
        """Recent commits, newest first: hash, authorName, date (ISO), subject.
        Empty on a repo with no commits yet (or no repo at all)."""
        if not await self.is_repo():
            return []
        sep = "\x1f"
        fmt = f"%h{sep}%an{sep}%aI{sep}%s"
        args = ["log", f"--max-count={max(1, min(limit, 200))}", f"--format={fmt}"]
        if path:
            args += ["--", path]
        rc, out, _ = await self._run(*args, check=False)
        if rc != 0:
            return []  # unborn HEAD
        entries: list[dict[str, str]] = []
        for line in out.splitlines():
            parts = line.split(sep)
            if len(parts) == 4:
                entries.append(
                    {
                        "hash": parts[0],
                        "authorName": parts[1],
                        "date": parts[2],
                        "subject": parts[3],
                    }
                )
        return entries

    async def show(self, ref: str, path: str | None = None) -> str:
        """One commit's unified diff (with subject header), optionally scoped
        to a path. The ref is validated to a short/full hex hash — never an
        arbitrary revision expression."""
        _validate_hex_ref(ref)
        args = ["show", "--stat=72", "--patch", "--format=%h %an %aI%n%s%n", ref]
        if path:
            args += ["--", path]
        rc, out, err = await self._run(*args, check=False)
        if rc != 0:
            raise GitError("show_failed", err.strip() or "no such commit")
        # Bound the payload — a pathological commit must not flood the UI.
        return out if len(out) <= 200_000 else out[:200_000] + "\n… (truncated)\n"

    async def stash(self) -> None:
        rc, _, err = await self._run("stash", "push", "-u", check=False)
        if rc != 0 and "no local changes" not in err.lower():
            raise GitError("stash_failed", err.strip() or "stash failed")

    async def discard_all(self) -> None:
        await self._run("reset", "--hard", check=False)
        await self._run("clean", "-fd", check=False)

    # -- Checkpoints -------------------------------------------------------
    #
    # Whole-workspace shadow commits under refs/sanad/checkpoints/*, kept
    # OUTSIDE refs/heads so they never appear as branches, are never checked
    # out, and never touch HEAD or the real .git/index. Every tree/commit/
    # restore op below runs against a throwaway GIT_INDEX_FILE (never the
    # real index) and is always cleaned up in a `finally`.

    def _new_scratch_index(self) -> Path:
        """A fresh, empty temp file for `GIT_INDEX_FILE` — every checkpoint
        tree/commit/restore op below runs against one of these, never the
        real `.git/index`. Created via mkstemp (atomic, race-free) under the
        CURRENT (unprivileged-split-agentd, i.e. root in task mode) process
        identity, then chowned to the agent uid/gid so the setuid'd git
        subprocess can still read/write it. Callers MUST unlink it in a
        `finally` — cleanup always succeeds: with uid split, agentd runs as
        root (bypasses ownership/sticky-bit checks); without uid split, the
        file is never chowned away from the caller's own uid."""
        fd, raw = tempfile.mkstemp(prefix="sanad-checkpoint-idx-")
        os.close(fd)
        if self._uid is not None:
            os.chown(raw, self._uid, self._gid if self._gid is not None else -1)
        return Path(raw)

    def _remove_worktree_relpath(self, rel: str) -> None:
        """Delete one path relative to `root` — used only for paths `git`
        itself reported (via `ls-files` on a throwaway index), never raw
        user input. Still refuses to leave root, as defense in depth."""
        if not rel or rel.startswith("/") or ".." in Path(rel).parts:
            return
        root = self._root.resolve()
        target = (root / rel).resolve()
        try:
            target.relative_to(root)
        except ValueError:
            return
        with contextlib.suppress(FileNotFoundError, IsADirectoryError):
            target.unlink()

    async def create_checkpoint(
        self, ref: str, message: str, *, parent: str | None = None
    ) -> str | None:
        """Snapshot the CURRENT worktree (tracked + untracked, via a
        throwaway index) into a commit under refs/sanad/checkpoints/<ref>,
        chained onto `parent` if given. Returns the new commit SHA, or None
        (creating nothing) when `parent` is given and the tree is unchanged
        since it — HEAD, the current branch, and the real index are never
        touched."""
        if not _CHECKPOINT_SUFFIX_RE.fullmatch(ref):
            raise GitError("invalid_ref", "invalid checkpoint ref")
        if parent is not None:
            _validate_hex_ref(parent, max_len=64)

        index_path = self._new_scratch_index()
        try:
            idx_env = {"GIT_INDEX_FILE": str(index_path)}
            await self._run("read-tree", "--empty", extra_env=idx_env)
            await self._run("add", "-A", extra_env=idx_env)
            _, tree_out, _ = await self._run("write-tree", extra_env=idx_env)
            tree = tree_out.strip()

            if parent is not None:
                _, parent_tree_out, _ = await self._run("rev-parse", parent + "^{tree}")
                if parent_tree_out.strip() == tree:
                    return None  # skip-when-clean: nothing changed since parent

            commit_args = ["commit-tree", tree]
            if parent is not None:
                commit_args += ["-p", parent]
            commit_args += ["-m", message]
            _, sha_out, _ = await self._run(*commit_args, extra_env=_CHECKPOINT_IDENTITY)
            sha = sha_out.strip()

            await self._run("update-ref", _CHECKPOINTS_NS + ref, sha)
            return sha
        finally:
            index_path.unlink(missing_ok=True)

    async def checkpoint_diff(
        self, base: str, target: str | None, *, path: str | None = None, max_bytes: int
    ) -> dict:
        """Diff two checkpoints, or one checkpoint against the current
        worktree (`target=None`) — read-only, but the worktree-snapshot step
        still goes through a throwaway index so the real one is untouched."""
        _validate_hex_ref(base, max_len=64)
        if target is not None:
            _validate_hex_ref(target, max_len=64)

        index_path: Path | None = None
        try:
            if target is None:
                index_path = self._new_scratch_index()
                idx_env = {"GIT_INDEX_FILE": str(index_path)}
                await self._run("read-tree", "--empty", extra_env=idx_env)
                await self._run("add", "-A", extra_env=idx_env)
                _, tree_out, _ = await self._run("write-tree", extra_env=idx_env)
                target_ref = tree_out.strip()
            else:
                target_ref = target

            path_args = ["--", path] if path else []
            rc, numstat_out, err = await self._run(
                "diff", "--numstat", base, target_ref, *path_args, check=False
            )
            if rc != 0:
                raise GitError("diff_failed", err.strip() or "diff failed")
            # -z (NUL-separated, unquoted paths): plain --name-status would
            # return core.quotePath-escaped paths for filenames with spaces/
            # unicode/special chars (e.g. `café.txt` -> `"caf\303\251.txt"`),
            # and these paths feed downstream per-file matching (the /diff
            # route + UI), so they must round-trip exactly.
            _, namestatus_out, _ = await self._run(
                "diff", "--name-status", "-z", base, target_ref, *path_args, check=False
            )
            _, patch_out, _ = await self._run("diff", base, target_ref, *path_args, check=False)
        finally:
            if index_path is not None:
                index_path.unlink(missing_ok=True)

        # -z name-status is a flat NUL-separated token stream: `<status>\0
        # <path>\0` normally, but `<status>\0<oldpath>\0<newpath>\0` for a
        # rename/copy (status "R###"/"C###") — use the NEW path for those.
        name_status = []
        tokens = [t for t in namestatus_out.split("\0") if t != ""]
        i = 0
        while i < len(tokens):
            status = tokens[i]
            i += 1
            if status[:1] in ("R", "C"):
                if i + 1 >= len(tokens):
                    break
                new_path = tokens[i + 1]
                i += 2
            else:
                if i >= len(tokens):
                    break
                new_path = tokens[i]
                i += 1
            name_status.append({"status": status, "path": new_path})

        files_changed = additions = deletions = 0
        for line in numstat_out.splitlines():
            if not line.strip():
                continue
            parts = line.split("\t", 2)
            if len(parts) < 3:
                continue
            files_changed += 1
            if parts[0].isdigit():
                additions += int(parts[0])
            if parts[1].isdigit():
                deletions += int(parts[1])

        patch_bytes = patch_out.encode("utf-8")
        truncated = len(patch_bytes) > max_bytes
        patch_text = patch_bytes[:max_bytes].decode("utf-8", "ignore") if truncated else patch_out

        return {
            "nameStatus": name_status,
            "patch": patch_text,
            "truncated": truncated,
            "filesChanged": files_changed,
            "additions": additions,
            "deletions": deletions,
        }

    async def restore_to(self, tree_ish: str) -> None:
        """Restore the WORKTREE to `tree_ish` — via a throwaway index, never
        the real one or HEAD. Two phases: (1) checkout every file `tree_ish`
        contains (overwrites modified files, recreates deleted ones); (2)
        delete every file present in the worktree now but absent from
        `tree_ish` (a file a later turn added). The caller (P5 Task 3) holds
        the workspace lock and has already taken a safety checkpoint."""
        _validate_hex_ref(tree_ish, max_len=64)

        checkout_index = self._new_scratch_index()
        scan_index = self._new_scratch_index()
        try:
            checkout_env = {"GIT_INDEX_FILE": str(checkout_index)}
            await self._run("read-tree", tree_ish, extra_env=checkout_env)
            await self._run("checkout-index", "-a", "-f", extra_env=checkout_env)

            # A SECOND throwaway index — a fresh `add -A` snapshot of the
            # worktree AFTER the checkout above — captures every path
            # present now, including anything a later turn added that
            # `checkout-index` (which only writes what's IN the tree) would
            # otherwise leave behind.
            scan_env = {"GIT_INDEX_FILE": str(scan_index)}
            await self._run("read-tree", "--empty", extra_env=scan_env)
            await self._run("add", "-A", extra_env=scan_env)
            # -z (NUL-separated, unquoted paths): this feeds a destructive
            # os.remove below, so a filename with a space/unicode/special
            # char must round-trip exactly, not come back core.quotePath-
            # escaped (`status()` uses -z for the same reason).
            _, now_out, _ = await self._run("ls-files", "-z", extra_env=scan_env)
            now_paths = {p for p in now_out.split("\0") if p}

            _, target_out, _ = await self._run("ls-tree", "-r", "-z", "--name-only", tree_ish)
            target_paths = {p for p in target_out.split("\0") if p}

            for rel in now_paths - target_paths:
                self._remove_worktree_relpath(rel)
        finally:
            checkout_index.unlink(missing_ok=True)
            scan_index.unlink(missing_ok=True)

    async def prune_checkpoints(self, cid: str, keep_turn_ids: list[str]) -> None:
        """Delete refs/sanad/checkpoints/<cid>/* refs whose turnId is not in
        `keep_turn_ids` (aligned with journal retention). Never touches
        refs outside that one conversation's checkpoint namespace."""
        if not _CID_RE.fullmatch(cid):
            raise GitError("invalid_ref", "invalid conversation id")
        keep = set(keep_turn_ids)
        prefix = f"{_CHECKPOINTS_NS}{cid}/"
        rc, out, _ = await self._run("for-each-ref", "--format=%(refname)", prefix, check=False)
        if rc != 0:
            return
        for line in out.splitlines():
            name = line.strip()
            if not name.startswith(prefix):
                continue
            suffix = name[len(prefix) :]
            m = _CHECKPOINT_SUFFIX_PART_RE.match(suffix)
            if m is None or m.group("turn_id") in keep:
                continue
            await self._run("update-ref", "-d", name, check=False)


def _validate_hex_ref(value: str, *, max_len: int = 40) -> None:
    """A ref must be a bare hex commit/tree hash — never an arbitrary
    revision expression (`main`, `HEAD~1`, ...), which could otherwise be
    used to smuggle in git command options or walk outside the intended ref."""
    if not all(c in "0123456789abcdef" for c in value.lower()) or not (4 <= len(value) <= max_len):
        raise GitError("invalid_ref", "not a commit hash")


def _checkpoint_ref(cid: str, turn_id: str, kind: str) -> str:
    """`<cid>/<turnId>-<kind>` — the ref suffix passed to
    `GitRepo.create_checkpoint`'s `ref` argument (which prepends
    `refs/sanad/checkpoints/`). Validates each component so a ref path can
    never be injected. `kind` is `pre`, `post`, or `safety-N`."""
    if not _CID_RE.fullmatch(cid):
        raise GitError("invalid_ref", "invalid conversation id")
    if not _TURN_ID_RE.fullmatch(turn_id):
        raise GitError("invalid_ref", "invalid turn id")
    if not _CHECKPOINT_KIND_RE.fullmatch(kind):
        raise GitError("invalid_ref", "invalid checkpoint kind")
    return f"{cid}/{turn_id}-{kind}"


def _validate_branch(name: str) -> None:
    if not name or len(name) > 255:
        raise GitError("invalid_branch", "invalid branch name")
    bad = {" ", "~", "^", ":", "?", "*", "[", "\\", ".."}
    if name.startswith("-") or any(b in name for b in bad) or name.endswith("/"):
        raise GitError("invalid_branch", "invalid branch name")
