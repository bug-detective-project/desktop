# Isolated QA runner: Node 26, the project's QA CLI and, when the CLI uses Playwright, Chromium
# (without stages: each run mounts the stage package read-only at /package).
FROM node:26.12.1-bookworm

ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    CI=1

WORKDIR /opt/qa
COPY cli/package.json cli/package-lock.json ./
# The CLI's postinstall would download Chromium without its system libraries; install both here,
# only for a QA tool that uses Playwright (a tool without it, like the tests' fixture, needs neither).
RUN npm ci --ignore-scripts --no-audit --no-fund \
 && if [ -x node_modules/.bin/playwright ]; then npx --no-install playwright install --with-deps chromium; fi \
 && rm -rf /var/lib/apt/lists/* /root/.npm

COPY cli/ ./
# /input (the QA input volume) and /source (the workspace volume) are mounted by the app's helper
# containers, which run as node: a fresh input volume takes node as its owner on the first mount.
RUN mkdir -p /cache /ms-playwright /input /source \
 && chown -R node:node /opt/qa /cache /ms-playwright /input /source

USER node
ENTRYPOINT ["node", "/opt/qa/run.ts"]
