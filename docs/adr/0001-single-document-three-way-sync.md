# Use single-document three-way synchronization with manual conflict resolution

Each operation targets one Markdown file paired with one SJTU Notes note, and compares local and remote logical content against a locally stored baseline. The tool deliberately has no project root, staging area, history, automatic merge, or cross-document asset database: these would turn a focused synchronization tool into a version-control system, while manual conflict bundles keep overwrites explicit and recoverable.
