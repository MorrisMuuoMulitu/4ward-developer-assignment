export const joinFormPage = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="color-scheme" content="light" />
    <title>Join a 4WARD city group</title>
    <style>
      :root {
        --paper: #f3eee4;
        --ink: #1d2724;
        --muted: #5d6964;
        --line: #c8c1b4;
        --accent: #cf5b3e;
        --accent-ink: #fffaf2;
        --field: #fffdf8;
        color: var(--ink);
        font-family: "Avenir Next", "Segoe UI", sans-serif;
        font-synthesis: none;
      }

      * { box-sizing: border-box; }

      body {
        min-height: 100vh;
        margin: 0;
        background:
          linear-gradient(var(--line) 1px, transparent 1px) 0 6.5rem / 100% 6.5rem,
          var(--paper);
        background-size: 100% 6.5rem;
      }

      .shell {
        display: grid;
        grid-template-columns: minmax(0, 0.9fr) minmax(20rem, 1.1fr);
        width: min(1120px, calc(100% - 2rem));
        min-height: 100vh;
        margin: 0 auto;
        align-items: center;
        gap: clamp(2rem, 8vw, 7rem);
        padding: 4rem 0;
      }

      .intro { align-self: start; padding-top: 2.5rem; }

      .wordmark {
        margin: 0 0 6rem;
        font-size: 0.78rem;
        font-weight: 800;
        letter-spacing: 0.16em;
        text-transform: uppercase;
      }

      h1 {
        max-width: 8ch;
        margin: 0;
        font-family: Georgia, "Times New Roman", serif;
        font-size: clamp(3.25rem, 8vw, 7rem);
        font-weight: 500;
        letter-spacing: -0.055em;
        line-height: 0.9;
      }

      .lede {
        max-width: 30rem;
        margin: 2rem 0 0;
        color: var(--muted);
        font-size: 1.05rem;
        line-height: 1.65;
      }

      .form-panel {
        background: var(--field);
        border: 1px solid var(--line);
        box-shadow: 12px 12px 0 #d8d0c3;
        padding: clamp(1.5rem, 5vw, 3.5rem);
      }

      .form-heading {
        margin: 0 0 0.5rem;
        font-family: Georgia, "Times New Roman", serif;
        font-size: 2rem;
        font-weight: 500;
      }

      .form-copy {
        margin: 0 0 2rem;
        color: var(--muted);
        line-height: 1.5;
      }

      .fields {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 1.2rem;
      }

      .field { display: grid; gap: 0.45rem; }
      .field--wide { grid-column: 1 / -1; }

      label { font-size: 0.78rem; font-weight: 750; letter-spacing: 0.04em; }
      .optional { color: var(--muted); font-weight: 500; }

      input {
        width: 100%;
        min-height: 3rem;
        border: 1px solid var(--line);
        border-radius: 0;
        background: #fff;
        color: var(--ink);
        font: inherit;
        padding: 0.72rem 0.8rem;
      }

      input:focus-visible,
      button:focus-visible {
        outline: 3px solid color-mix(in srgb, var(--accent), white 35%);
        outline-offset: 2px;
      }

      .hint { margin: 0; color: var(--muted); font-size: 0.78rem; line-height: 1.4; }

      button {
        grid-column: 1 / -1;
        min-height: 3.25rem;
        margin-top: 0.35rem;
        border: 0;
        background: var(--accent);
        color: var(--accent-ink);
        cursor: pointer;
        font: inherit;
        font-weight: 800;
        letter-spacing: 0.04em;
      }

      button:hover { background: #b84a30; }

      @media (max-width: 760px) {
        .shell {
          grid-template-columns: 1fr;
          gap: 2.5rem;
          padding: 2rem 0 3rem;
          align-items: start;
        }

        .intro { padding-top: 0.5rem; }
        .wordmark { margin-bottom: 3.5rem; }
        h1 { font-size: clamp(3.6rem, 18vw, 5.5rem); }
        .fields { grid-template-columns: 1fr; }
        .field--wide, button { grid-column: 1; }
        .form-panel { box-shadow: 7px 7px 0 #d8d0c3; }
      }
    </style>
  </head>
  <body>
    <main class="shell">
      <section class="intro" aria-labelledby="page-title">
        <p class="wordmark">4WARD.earth</p>
        <h1 id="page-title">Find your city.</h1>
        <p class="lede">
          Join a local group and meet people close to home who are moving the same ideas forward.
        </p>
      </section>

      <section class="form-panel" aria-labelledby="form-title">
        <h2 class="form-heading" id="form-title">Your details</h2>
        <p class="form-copy">Tell us where you belong and what you care about.</p>
        <form method="post" action="/api/join">
          <div class="fields">
            <div class="field">
              <label for="name">Full name</label>
              <input id="name" name="name" autocomplete="name" required maxlength="120" />
            </div>
            <div class="field">
              <label for="email">Email address</label>
              <input id="email" name="email" type="email" autocomplete="email" required />
            </div>
            <div class="field">
              <label for="city">City</label>
              <input id="city" name="city" autocomplete="address-level2" required maxlength="120" />
            </div>
            <div class="field">
              <label for="country">Country</label>
              <input id="country" name="country" autocomplete="country-name" required maxlength="120" />
            </div>
            <div class="field field--wide">
              <label for="interests">Interests <span class="optional">(optional)</span></label>
              <input
                id="interests"
                name="interests"
                aria-describedby="interests-hint"
                placeholder="Technology, Climate, Design"
              />
              <p class="hint" id="interests-hint">Separate each interest with a comma.</p>
            </div>
            <button type="submit">Request to join</button>
          </div>
        </form>
      </section>
    </main>
  </body>
</html>`;
