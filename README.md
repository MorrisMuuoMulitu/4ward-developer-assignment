# 4WARD.earth Developer Screening

This repository is the starter repository for the 4WARD.earth developer screening case study.

## Candidate task

Read `Architecture.md` and implement the described event-driven system.

The candidate should:

- Fork this repository.
- Implement the producer service.
- Implement any two of the three destination consumers: Airtable, Brevo, or Supabase.
- Add automated tests.
- Add retry handling.
- Use the supplied data contracts.
- Complete `NOTES.md`.
- Submit the completed repository as a fork.

The full candidate brief is included in `CASE_STUDY.md`.

## Repository structure

```text
.
├── Architecture.md
├── CASE_STUDY.md
├── NOTES.md
├── .env.example
├── producer/
├── consumers/
│   ├── airtable/
│   ├── brevo/
│   └── supabase/
├── shared/
└── docs/
```

The implementation structure is intentionally left open to the candidate.
