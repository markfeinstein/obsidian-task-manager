# Large Vault Fixture Generator

This directory contains utilities for generating large test vaults (10K+ tasks).

## Generated Files

Run `generate-large-vault.ts` to create:
- `large-vault.md` - 10K tasks with varied structure and metadata

## Usage

```typescript
import { generateLargeVault } from './generate-large-vault';

const markdown = generateLargeVault(10000);
// Use in tests
```
