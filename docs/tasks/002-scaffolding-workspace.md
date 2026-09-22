# XP-002: Scaffolding del workspace y quality gates

- Estado: `done`
- Milestone: M1
- Dependencias: XP-001

## Objetivo

Crear la estructura mínima que haga cumplir los límites del RFC 0005 sin
implementar todavía comportamiento de producto.

## Alcance

- Crear el workspace Rust y los crates iniciales necesarios para M1.
- Crear el paquete TypeScript `adapters/pi`.
- Separar dominio, aplicación, protocolo, infraestructura y binario.
- Configurar formato, lint, typecheck y tests.
- Preparar CI básica y cachés reproducibles.
- Añadir comprobaciones que impidan dependencias de harness en el core.

## Entregables

- Workspace que compila sin warnings acordados.
- Comandos de desarrollo documentados.
- Test mínimo por crate y por paquete TypeScript.
- ADR breve si el layout final difiere del RFC 0005.

## Criterios de aceptación

- Una instalación limpia puede ejecutar todas las comprobaciones.
- `xper-domain` no depende de I/O, SQLite, CLI ni SDKs externos.
- El adaptador Pi sólo depende del protocolo público.
- CI ejecuta formato, lint, typecheck y tests.

## Fuera de alcance

- Añadir todos los crates futuros vacíos.
- Implementar el bridge o la máquina de estados.

## Resultado

- Workspace Rust con los seis crates necesarios para M1 y toolchain fijado.
- Workspace npm con `adapters/pi`, TypeScript estricto y dependencias fijadas.
- Gates unificados mediante `npm run check`: formato, lint, límites de
  dependencias, typecheck y tests.
- CI con caché de Cargo/npm y el mismo conjunto de gates locales.
- Layout alineado con RFC 0005; no fue necesario añadir un ADR.
