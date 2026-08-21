# SJTU Notes Synchronization

This context describes the language used when one local Markdown document is synchronized with one note on SJTU Notes.

## Language

**Tracked Document**:
A Local Markdown paired with exactly one Remote Note and a Sync Baseline.
_Avoid_: Project, repository, workspace

**Local Markdown**:
The user-owned Markdown file on disk. Its direct image references use local paths.
_Avoid_: Local note, working tree

**Remote Note**:
The CodiMD note hosted by SJTU Notes that is paired with a Tracked Document.
_Avoid_: Cloud file, remote file

**Sync Baseline**:
The last content state known to be common to the Local Markdown and Remote Note, after accounting for local image paths and remote image URLs.
_Avoid_: Commit, snapshot, revision

**Asset**:
An image file referenced directly by Markdown image syntax or an HTML `img` element and synchronized separately from Markdown text.
_Avoid_: Attachment, embedded file

**Conflict**:
A state in which both the Local Markdown and Remote Note differ from the Sync Baseline and automatic overwrite is unsafe.
_Avoid_: Merge failure, collision

**Conflict Bundle**:
A local, hidden set of baseline and remote reference files created to support manual resolution of a Conflict.
_Avoid_: Merge result, recovery copy
