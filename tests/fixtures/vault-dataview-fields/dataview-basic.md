# Basic Dataview Field Examples

Demonstrates core Dataview inline field format.

## Simple Fields

- [ ] Task [priority:: high]
- [ ] Task [effort:: 2h]
- [ ] Task [owner:: alice]
- [ ] Task [status:: todo]

## Multiple Fields Per Task

- [ ] Feature implementation [priority:: high] [effort:: 3h] [owner:: bob] [deadline:: 2026-06-15]
- [ ] Bug fix [priority:: critical] [effort:: 1h] [owner:: alice] [status:: in-progress]
- [ ] Documentation [priority:: low] [effort:: 4h] [team:: docs] [deadline:: 2026-06-30]

## Different Field Types

- [ ] Sprint planning [date:: 2026-06-02] [duration:: 2h] [attendees:: 5] [room:: Conference A]
- [ ] Code review [reviewer:: alice] [lines:: 500] [complexity:: high] [estimate:: 1h]
- [ ] Testing [test_count:: 42] [coverage:: 85%] [environment:: staging] [status:: complete]

## Nested Structure with Fields

- [ ] Project phase [status:: active] [progress:: 60%]
  - [ ] Task 1 [owner:: alice] [effort:: 2h]
  - [ ] Task 2 [owner:: bob] [effort:: 3h]
  - [ ] Task 3 [owner:: charlie] [effort:: 1h]

## Linked Fields

- [ ] Requires [[backend-api]] [related:: [[database-schema]]]
- [ ] Blocks [[frontend-ui]] [depends:: [[api-server]]]
