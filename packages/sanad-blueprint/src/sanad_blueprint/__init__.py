"""The .sanad blueprint kernel — schemas, indexer, graph compiler, validation.

The filesystem is the source of truth. Everything here reads files under a
repository's ``.sanad`` directory and produces derived, disposable projections
(an index, a graph, diagnostics). Nothing here executes resource commands —
parsing a manifest never runs it (PRD principle 6.6).
"""

from __future__ import annotations

from .diagnostics import Diagnostic, Severity
from .graph import BlueprintGraph, Edge, Node, compile_graph
from .indexer import BlueprintIndex, IndexedResource, index_blueprint
from .schemas import API_VERSION, KIND_MODELS, ResourceKind

__all__ = [
    "API_VERSION",
    "KIND_MODELS",
    "BlueprintGraph",
    "BlueprintIndex",
    "Diagnostic",
    "Edge",
    "IndexedResource",
    "Node",
    "ResourceKind",
    "Severity",
    "compile_graph",
    "index_blueprint",
]
