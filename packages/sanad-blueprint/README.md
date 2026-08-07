# sanad-blueprint

The `.sanad` blueprint kernel: resource schemas, the filesystem indexer, the
graph compiler, and validation. Pure Python (pydantic + PyYAML, no framework)
so the same core serves agentd on the project machine and the `sanad
blueprint validate` CLI/CI path.

The filesystem is canonical: the index and graph are derived, disposable
projections of the files under a repository's `.sanad` directory.
