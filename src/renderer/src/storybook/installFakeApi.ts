// Imported first by .storybook/preview.tsx: api.ts reads window.bugDetective when it is imported.
import { fakeApi } from './fakeApi.ts';

window.bugDetective = fakeApi;
