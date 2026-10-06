// A "⋯" button with a small menu of actions (react-aria-components). The
// popover has the class "ui-pop", like the dropdowns in Select.tsx.

import type { ReactNode } from 'react';
import { Button, Menu, MenuItem, MenuTrigger, Popover } from 'react-aria-components';
import { More } from './icons.tsx';

export interface Action {
  id: string;
  label: string;
  icon?: ReactNode;
  danger?: boolean;
  onAction(): void;
}

export function ActionMenu({ label, actions, className = '' }: { label: string; actions: Action[]; className?: string }) {
  if (!actions.length) return null;
  return (
    <MenuTrigger>
      <Button className={'ui-more ' + className} aria-label={label}>
        <More />
      </Button>
      <Popover className="ui-pop" offset={4} placement="bottom end">
        <Menu className="ui-list" onAction={(id) => actions.find((a) => a.id === id)?.onAction()}>
          {actions.map((a) => (
            <MenuItem key={a.id} id={a.id} textValue={a.label} className={'ui-item ui-action' + (a.danger ? ' danger' : '')}>
              {a.icon}
              <span>{a.label}</span>
            </MenuItem>
          ))}
        </Menu>
      </Popover>
    </MenuTrigger>
  );
}
