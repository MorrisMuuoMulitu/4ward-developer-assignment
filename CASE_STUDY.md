# 4WARD.earth Developer Screening Case Study

**Estimated time:** 5-6 hours  
**Language:** TypeScript or Python  
**Repository:** 

## 1. Premise

4WARD has communities and groups associated with different cities.

When a person wants to join a city's group, their information needs to be recorded across several systems used by the organisation.

For this exercise, assume that a user joining a city group needs to be added to:

- Airtable for internal tracking
- Brevo for communications
- Supabase for application data

We want to avoid tightly coupling the system that collects the information with each individual external platform.

Instead, the system should use an event-driven architecture where the producer publishes an event and independent consumer services process that event for their respective destinations.

The expected architecture is provided in `Architecture.md`.

**Your task is to implement the architecture described there.**

You are not expected to redesign the architecture. Focus on building a clean, working implementation of the supplied design.

## 2. Your Task

Build a small system that allows a user to request to join a city's group.

The system should contain:

### Producer service

1. Accept the user's information through a form or API endpoint.
2. Validate the submitted information.
3. Create a `CityGroupJoined` event.
4. Publish the event to the message queue/topic.

### Consumer services

Create any two of the three independent consumer services:

1. Airtable Consumer
2. Brevo Consumer
3. Supabase Consumer

Each consumer should:

- Subscribe to the event.
- Transform the event into the destination format.
- Call its destination API.
- Handle failures according to the supplied architecture.

Each consumer should be responsible for exactly one external destination.

A failure in one consumer must not prevent the other consumers from processing the event.

## 3. Data Structures

The required data structures are provided in `Architecture.md`. You do not need to design the data model.

## 4. Retries and Failures

Implement retry handling for consumer failures according to `Architecture.md`.

Demonstrate:

- A failed processing attempt being retried.
- A configurable maximum number of attempts.
- A message only being acknowledged after successful processing.
- Appropriate handling when retry attempts are exhausted.
- Failure isolation between consumers.

Consider what happens if the same event is delivered more than once.

## 5. Testing

Include automated tests covering important behaviour such as:

- Input validation.
- Event creation.
- Event publishing.
- Consumer processing.
- Data transformation.
- Successful processing.
- Failed processing and retries.

Mock external APIs where appropriate.

Also manually verify communication with the real service(s) you implement.

## 6. Verification

Verify the end-to-end flow and at least one failure/retry scenario.

Include evidence in the repository. Screenshots, a short recording, test output, or another clear demonstration are acceptable.

## 7. Questions to Answer

Include a short `NOTES.md` or README section answering:

1. What was the most important implementation decision you made, and why?
2. What was the most difficult part of implementing the system? How did you investigate and resolve it?
3. What assumptions did you make while implementing the specification?
4. How did you verify that your implementation works beyond seeing your automated tests pass?
5. Describe one failure scenario you tested. What happened at each stage?
6. Before submitting your work, what checks did you run? Include the actual commands or processes.
7. If you had to add another destination, what parts would you change?
8. Were any parts of the architecture or specification unclear, or would you have implemented differently? Explain.
9. What tools did you use during development?
10. Identify one piece of code or approach suggested by a tool that you changed, rejected, or verified before using. Why?

## 8. Repository and Submission

Fork this repository and implement your solution in your fork.

You may organise the project as a monorepo.

The expected top-level structure is:

```text
/
├── Architecture.md
├── CASE_STUDY.md
├── README.md
├── NOTES.md
├── .env.example
├── producer/
├── consumers/
│   ├── airtable/
│   ├── brevo/
│   └── supabase/
└── ...
```

The exact implementation structure is up to you.

Submit the URL to your completed repository.

## 9. Guidelines

### Technology

Use either TypeScript or Python.

### External services

Use your own free accounts for Airtable, Brevo and Supabase.

Do not request or use 4WARD credentials.

### Credentials

Do not commit API keys, passwords, tokens or other secrets.

Use environment variables and provide `.env.example`.

### AI tools

AI coding assistants are permitted. You remain responsible for the implementation and its correctness.

### Scope

This is a small prototype, not a production platform.

Do not spend time building:

- A sophisticated frontend
- Complex authentication
- Kubernetes infrastructure
- Elaborate monitoring
- Production deployment pipelines
- Unnecessary abstractions

Prioritise a working, understandable implementation.

### Existing code

The repository may contain starter code, configuration, tests or examples.

Work within the provided structure where appropriate rather than replacing the project unnecessarily.

### Changes to tests

If you modify an existing test, make sure the change reflects an intentional change in expected behaviour and document the reason.

Do not modify tests simply to make an implementation pass.

### Before submission

Make sure you have:

- Run the relevant automated tests.
- Run linting/type-checking/build commands where applicable.
- Reviewed your own changes.
- Verified the end-to-end flow.
- Checked that no secrets or unnecessary files are included.
- Confirmed another developer can follow the README and run the project.
- Checked the final repository and submitted changes rather than relying only on intermediate local results.

## 10. What We Will Evaluate

- Technical implementation
- Reliability
- Testing
- Code quality
- Engineering judgement
- Security
- Ownership
- Communication

There is no expectation that the implementation will be production-ready. We are primarily interested in seeing how you approach a real engineering task and deliver a working result.
