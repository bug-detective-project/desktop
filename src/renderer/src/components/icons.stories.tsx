import type { Meta, StoryObj } from '@storybook/react-vite';
import { Icon } from './icons.tsx';
import type { IconName } from './icons.tsx';

// Every icon the app draws (the keys of icons.tsx's map).
const NAMES: IconName[] = ['mail','board','settings','check','checkCircle','arrowRight','arrowLeft','chevronDown','externalLink','download','alertTriangle','alertCircle','spinner','refresh','code','play','pause','server','hardDrive','info','helpCircle','laptop','sun','moon','rotateCcw','trash','x','clipboardList','package','users','briefcase','contact','inbox'];

const meta = { title: 'Components/Icons' } satisfies Meta;
export default meta;

export const Gallery: StoryObj<typeof meta> = {
  render: () => (
    <ul className="grid grid-cols-[repeat(auto-fill,minmax(120px,1fr))] gap-3">
      {NAMES.map((name) => (
        <li key={name} className="flex flex-col items-center gap-2 rounded-lg border border-border p-3 text-sm text-foreground">
          <Icon name={name} className="size-5" />
          <span className="font-mono text-xs">{name}</span>
        </li>
      ))}
    </ul>
  ),
};
