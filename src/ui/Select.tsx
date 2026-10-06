// Dropdowns and date pickers that look the same everywhere (native <select>
// and <input type=date> popups follow the OS, and on Windows clash with the
// dark theme). Built on react-aria-components for keyboard and screen
// readers. Popovers render at the end of <body> with the class "ui-pop".

import type { ReactNode } from 'react';
import {
  Button,
  Calendar,
  CalendarCell,
  CalendarGrid,
  DateInput,
  DatePicker as RacDatePicker,
  DateSegment,
  Dialog,
  Group,
  Heading,
  ListBox,
  ListBoxItem,
  Popover,
  Select as RacSelect,
  SelectValue,
} from 'react-aria-components';
import { CalendarDate } from '@internationalized/date';
import { dayFromYMD, ymd, type Day } from '../lib/dates.ts';
import { Calendar as CalendarIcon, Check, ChevronDown, ChevronLeft, ChevronRight, Close } from './icons.tsx';

/** A dropdown or date picker is open (its clicks aren't "outside" a panel). */
export const isPopoverOpen = () => !!document.querySelector('.ui-pop');

// React Aria keys can't be '', which several of our options use ("none").
const EMPTY = '\u0000';
const toKey = (v: string) => (v === '' ? EMPTY : v);
const fromKey = (k: string) => (k === EMPTY ? '' : k);

export interface Option<T extends string> {
  value: T;
  label: string;
}

export function Select<T extends string>({
  value,
  options,
  onChange,
  label,
  icon,
  className = '',
  isDisabled,
}: {
  value: T;
  options: readonly Option<T>[];
  onChange(value: T): void;
  /** Accessible name. */
  label: string;
  icon?: ReactNode;
  className?: string;
  isDisabled?: boolean;
}) {
  return (
    <RacSelect
      className={'ui-select ' + className}
      aria-label={label}
      selectedKey={toKey(value)}
      onSelectionChange={(k) => k !== null && onChange(fromKey(String(k)) as T)}
      isDisabled={isDisabled}
    >
      <Button className="ui-select-btn">
        {icon}
        <SelectValue className="ui-select-value" />
        <ChevronDown size={14} />
      </Button>
      <Popover className="ui-pop" offset={4} placement="bottom start">
        <ListBox className="ui-list">
          {options.map((o) => (
            <ListBoxItem key={toKey(o.value)} id={toKey(o.value)} textValue={o.label} className="ui-item">
              {({ isSelected }) => (
                <>
                  <span>{o.label}</span>
                  {isSelected && <Check size={14} />}
                </>
              )}
            </ListBoxItem>
          ))}
        </ListBox>
      </Popover>
    </RacSelect>
  );
}

const toCal = (day: Day) => {
  const { y, m, d } = ymd(day);
  return new CalendarDate(y, m + 1, d);
};
const fromCal = (c: { year: number; month: number; day: number }) => dayFromYMD(c.year, c.month - 1, c.day);

/** A day, typed or picked from a calendar. `null` = no date (when clearable). */
export function DatePicker({
  value,
  onChange,
  label,
  clearable,
  placeholder,
  className = '',
}: {
  value: Day | null;
  onChange(day: Day | null): void;
  label: string;
  clearable?: boolean;
  /** Shown instead of empty date segments. */
  placeholder?: string;
  className?: string;
}) {
  return (
    <RacDatePicker
      className={'ui-date ' + className + (value === null ? ' is-empty' : '')}
      aria-label={label}
      value={value === null ? null : toCal(value)}
      onChange={(v) => {
        if (v) onChange(fromCal(v));
        else if (clearable) onChange(null);
      }}
      shouldForceLeadingZeros={false}
    >
      <Group className="ui-date-group">
        {value === null && placeholder ? (
          <Button className="ui-date-placeholder">{placeholder}</Button>
        ) : (
          <DateInput className="ui-date-input">{(segment) => <DateSegment segment={segment} className="ui-date-seg" />}</DateInput>
        )}
        {clearable && value !== null && (
          <button type="button" className="ui-date-clear" aria-label={`Clear ${label}`} onClick={() => onChange(null)}>
            <Close size={12} />
          </button>
        )}
        <Button className="ui-date-btn" aria-label={`Pick ${label}`}>
          <CalendarIcon />
        </Button>
      </Group>
      <Popover className="ui-pop" offset={6} placement="bottom end">
        <Dialog className="ui-cal-dialog" aria-label={label}>
          <Calendar className="ui-cal">
            <header className="ui-cal-head">
              <Button slot="previous" className="ui-cal-nav">
                <ChevronLeft />
              </Button>
              <Heading className="ui-cal-title" />
              <Button slot="next" className="ui-cal-nav">
                <ChevronRight />
              </Button>
            </header>
            <CalendarGrid className="ui-cal-grid">{(date) => <CalendarCell date={date} className="ui-cal-cell" />}</CalendarGrid>
          </Calendar>
        </Dialog>
      </Popover>
    </RacDatePicker>
  );
}
