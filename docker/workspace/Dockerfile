# The player's workspace: the Node image of the projects' dev containers, the "node" user, the
# workspaces volume at /workspaces (one folder per project, created at run time), Git settings and
# a port forwarder for the Vite dev server.
FROM node:26.12.1-bookworm

# The snapshot imports and the player's work keep LF line endings, whatever the host settings are.
# One user inside the container; the repository folder is created per project at run time.
# Git reads its settings from a read-only file of the image (GIT_CONFIG_GLOBAL) and ignores
# /etc/gitconfig (GIT_CONFIG_NOSYSTEM): the Dev Containers extension writes the player's git
# credential helper there (`git config --system` as root, `--global` as node) and copies the
# player's ~/.gitconfig into the container; with this, the global write fails and neither file
# is ever read. GnuPG leaves the image too: the extension forwards the computer's gpg agent only
# into a container that has gpg. (Task 4.2 of the loose-ends plan.)
RUN mkdir -p /etc/bugdetective \
 && git config --file /etc/bugdetective/gitconfig core.autocrlf false \
 && git config --file /etc/bugdetective/gitconfig core.eol lf \
 && git config --file /etc/bugdetective/gitconfig --add safe.directory '*' \
 && git config --file /etc/bugdetective/gitconfig init.defaultBranch main \
 && chmod 444 /etc/bugdetective/gitconfig && chmod 555 /etc/bugdetective \
 && (apt-get purge -y --auto-remove gnupg gpg gpg-agent gpgconf gpgsm dirmngr gpg-wks-client gpg-wks-server || true) \
 && rm -rf /var/lib/apt/lists/*
ENV GIT_CONFIG_GLOBAL=/etc/bugdetective/gitconfig GIT_CONFIG_NOSYSTEM=1

COPY forward.mjs /usr/local/lib/bugdetective/forward.mjs

# The named volumes copy ownership from these folders the first time they are mounted.
RUN mkdir -p /workspaces /home/node/.vscode-server \
 && chown -R node:node /workspaces /home/node/.vscode-server

USER node
WORKDIR /workspaces
ENV NPM_CONFIG_UPDATE_NOTIFIER=false

# 15173 forwards to the Vite dev server (which only listens on localhost); 3001 is the API.
EXPOSE 15173 3001
CMD ["node", "/usr/local/lib/bugdetective/forward.mjs"]
