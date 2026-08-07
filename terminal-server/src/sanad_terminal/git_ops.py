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
import os
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path


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

    async def _run(self, *args: str, check: bool = True) -> tuple[int, str, str]:
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
            return
        await self._run("init", "-b", "main")
        # A default local identity so the first commit never fails; the commit
        # endpoint overrides author/committer per call from the signed-in user.
        await self._run("config", "user.name", "Sanad Workspace")
        await self._run("config", "user.email", "workspace@sanadcode.com")

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

    async def stash(self) -> None:
        rc, _, err = await self._run("stash", "push", "-u", check=False)
        if rc != 0 and "no local changes" not in err.lower():
            raise GitError("stash_failed", err.strip() or "stash failed")

    async def discard_all(self) -> None:
        await self._run("reset", "--hard", check=False)
        await self._run("clean", "-fd", check=False)


def _validate_branch(name: str) -> None:
    if not name or len(name) > 255:
        raise GitError("invalid_branch", "invalid branch name")
    bad = {" ", "~", "^", ":", "?", "*", "[", "\\", ".."}
    if name.startswith("-") or any(b in name for b in bad) or name.endswith("/"):
        raise GitError("invalid_branch", "invalid branch name")
