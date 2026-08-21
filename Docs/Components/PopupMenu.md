# Popup menu architecture

Codiware uses `public/js/core/PopupMenu.js` as the shared popup/context menu controller for feature menus.

## Responsibilities

The shared controller owns all browser-side popup menu mechanics:

- rendering menu descriptors into `.codiware-popup-menu` DOM nodes;
- showing Font Awesome or SVG icons via the central `Icon.render()` helper;
- rendering separators and disabled menu items consistently;
- opening anchored menus and coordinate-based context menus;
- maintaining one active menu tree so opening a new menu closes the previous one;
- rendering nested submenus;
- keeping menus inside the viewport;
- closing menus on outside pointer/click, context menu changes, `Escape`, scroll and resize.

Feature modules only provide menu item descriptors and business callbacks. They must not implement their own outside-click, submenu-hover or positioning logic.

## Touch-screen rules

Touch and pen pointers are treated differently from mouse pointers. Mouse users can open submenus by hovering a parent menu item. Touch and pen users open submenus only by tapping the parent item. This prevents mobile browsers such as Android Chrome from firing a hover-like `pointerenter` during a tap and then immediately activating the first submenu action.

Outside-close handling uses pointer events in addition to mouse events, because not every mobile browser dispatches a desktop-style `mousedown` after a tap.

## Usage

Use the singleton for normal menus:

```
 
import { PopupMenu } from '../core/PopupMenu.js';
 
PopupMenu.open(anchorButton, [
  { icon: 'fa fa-file-o', label: 'Open', onClick: () => openFile() },
  { sep: true },
  {
    icon: 'fa fa-undo',
    label: 'Reset',
    children: [
      { icon: 'fa fa-step-backward', label: 'Soft reset', onClick: () => reset('soft') },
      { icon: 'fa fa-warning', label: 'Hard reset', onClick: () => reset('hard') }
    ]
  }
]);
 
```

Use `PopupMenu.openAt(clientX, clientY, items)` for right-click context menus. Use `createPopupMenuController()` only when a truly isolated menu stack is needed.

## Implementation principles

Do not add new local popup menu implementations. Existing feature-local menus should be replaced with this shared controller whenever the owning file is touched. The singleton is also exposed as `window.CodiwarePopupMenu` so extensions and temporary compatibility code can use the same behaviour without importing from an internal module path.
