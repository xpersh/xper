# XP-004: Protocolo v1 y bridge por stdio

- Estado: `pending`
- Milestone: M1
- Dependencias: XP-002 y resultados de XP-001

## Objetivo

Validar el límite multilenguaje mediante un handshake real entre un cliente
TypeScript y el proceso Rust `xper bridge --stdio`.

## Alcance

- Definir envelope, IDs de correlación, errores y negociación de versión.
- Definir `initialize`, `capabilities`, `ping` y `shutdown`.
- Implementar framing JSONL y JSON-RPC bidireccional.
- Reservar stdout exclusivamente para protocolo y stderr para logs.
- Publicar JSON Schema de los mensajes.
- Gestionar cierre, timeout, mensaje inválido y versión incompatible.

## Criterios de aceptación

- TypeScript inicia el bridge y completa un handshake.
- Cliente y servidor pueden iniciar peticiones.
- Los contract tests usan las mismas fixtures en Rust y TypeScript.
- Un mensaje desconocido o demasiado grande falla de forma controlada.
- Reiniciar el bridge no requiere estado residente para completar el handshake.

## Fuera de alcance

- Eventos completos de agentes.
- Socket local, daemon global o comunicación por red.
