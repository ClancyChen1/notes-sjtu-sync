# Install the CLI and agent skill separately

The npm package provides the `notes-sjtu-sync` executable and also ships the skill source, but installation never mutates an agent's skill directories. Users install the CLI through npm and explicitly install `skills/notes-sjtu-sync` through their agent's skill installer, avoiding surprising postinstall writes while keeping both release artifacts together.
