import type { Meta, StoryObj } from '@storybook/react-vite';
import { Markdown } from './Markdown.tsx';

const meta = { title: 'Components/Markdown', component: Markdown } satisfies Meta<typeof Markdown>;
export default meta;
export const Ticket: StoryObj<typeof meta> = {
  args: {
    children: '# NT-12: An empty title shows nothing\n\n## Steps to reproduce\n\n1. Create a note without a title.\n2. Open the list.\n\n**Expected:** the note shows *Untitled*.\n\n```js\ntitleOf({ title: \'\' })\n```\n\n- [x] Reproduced\n- [ ] Fixed',
  },
};
