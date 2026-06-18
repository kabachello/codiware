# Codiware cloud IDE

Codiware Editor is a browser-based PHP/JS IDE delivered as a Composer package and exposed through one configurable middleware mounted below a single URL prefix, `codiware/` by default. It is designed to be plugged into the routing of other PHP apps to quickly add an integrated IDE on dev/test systems.

The primary use case is the integration with the ExFace no-code platform for business web apps. The app axenox.IDE connects the two projects. It is added to an ExFace installation via composer and includes the  Codiware IDE as a dependency. the IDE must be useable after a composer install without any additional compilation steps!

CRITICAL: make sure no changes break compatibility with ExFace!

## Documentation

The technical architecture is described in [Architecture.md](../Docs/Architecture.md). The UI principles can be found in [Styleguide.md](../Docs/Styleguide.md).

IMPORTANT: 
- when planning changes, always read these files
- if explicit requirement imply changes to these files, always update them after the change. Make sure to keep them up tp date!
- Always follow the style guide when creating new UIs. If a new type of UX is necessary, add it to the style guide and make sure you use the same pattern next time you need something similar. UI patterns in different parts of the application MUST share the same CSS classes and not only "look" similar.

## Code

All code required for a typical IDE is either availavle in this package or included in its comoser.json.

The server side is written in modern PHP. The front-end is an SPA in vanilla JavaScript and includes some third-party libraries installed by Composer via "asset-packagist" NPM bridge.