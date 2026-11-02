import { useRef } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';

/**
 * A switch-like group of options (language, theme, difficulty): `<testId>-select` on the group,
 * `<testId>-<value>` on each option. A radio group: Tab reaches the selected option, and the arrow
 * keys move to the next or previous one, selecting it.
 */
export function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
  testId,
}: {
  label: string;
  value: T;
  options: { value: T; icon: ReactNode; text: string }[];
  onChange: (value: T) => void;
  testId: string;
}) {
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);
  const move = (event: KeyboardEvent, index: number) => {
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
    if (step === undefined) {
      return;
    }
    event.preventDefault();
    const next = (index + step + options.length) % options.length;
    onChange(options[next].value);
    buttons.current[next]?.focus();
  };
  return (
    <div className="inline-flex items-center gap-1 rounded-lg border border-border bg-secondary/50 p-1" role="radiogroup" aria-label={label} data-testid={`${testId}-select`}>
      {options.map((option, index) => {
        const selected = option.value === value;
        return (
          <button
            key={option.value}
            ref={(element) => {
              buttons.current[index] = element;
            }}
            type="button"
            role="radio"
            aria-checked={selected}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(option.value)}
            onKeyDown={(event) => move(event, index)}
            className={`flex items-center gap-2 rounded-md px-3 py-1.5 text-base whitespace-nowrap transition-all focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none ${
              selected ? 'bg-card font-semibold text-foreground shadow-xs ring-1 ring-border' : 'font-medium text-muted-foreground hover:text-foreground'
            }`}
            data-testid={`${testId}-${option.value}`}
          >
            {option.icon}
            {option.text}
          </button>
        );
      })}
    </div>
  );
}
