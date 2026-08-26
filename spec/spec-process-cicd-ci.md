---
title: CI/CD Workflow Specification - CI
version: 1.0
date_created: 2026-08-23
last_updated: 2026-08-23
owner: seankrux
tags: [process, cicd, github-actions, raycast-ai-bridge]
---

## Workflow Overview

**Purpose**: Fleet template detect-and-run CI. Detects Node or Python manifests and optionally installs/tests.
**Trigger Events**: Push to main/master; pull requests.
**Target Environments**: Ephemeral Ubuntu CI.

## Execution Flow Diagram

```mermaid
graph TD
    A[Push / PR] --> B[detect-and-run]
    B --> C[End]
    style A fill:#e1f5fe
    style C fill:#e8f5e8
```

## Jobs & Dependencies

| Job Name | Purpose | Dependencies | Execution Context |
|---|---|---|---|
| detect-and-run | Optional install/test | none | ubuntu-latest |

## Requirements Matrix

| ID | Requirement | Priority | Acceptance Criteria |
|---|---|---|---|
| REQ-001 | Do not fail if tests are absent | Medium | Missing test script is a no-op |
| REQ-002 | No secrets in YAML | High | Workflow references no credentials |

## Notes

This is a copied fleet template. Do not treat it as a hard quality gate unless the repo has real tests.

## Change Management

| Version | Date | Changes | Author |
|---|---|---|---|
| 1.0 | 2026-08-23 | Initial specification | fleet audit |
