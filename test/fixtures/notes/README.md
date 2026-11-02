# Notes

A tiny note-taking app used by the integration tests, so they never depend on SupportDesk. It has
no dependencies: `npm run dev` serves the client on 5173 and the API on 3001, and the QA CLI
(`qa/run.ts`) runs each gate with `node --test`. `test/helpers/notes-project.ts` builds it as a
published project: `main` from `main/`, the `qa` branch from `qa/`, and one branch per ticket from
`tickets/<id>/buggy/` (the file with the bug).
