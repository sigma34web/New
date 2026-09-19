# Blinded Human Review Package — Yeonjae Studio

**Protocol Reference**: `docs/07-quality/01-testing-strategy.md` §6, `ADR-0029`  
**Status**: `HUMAN_REVIEW_PENDING` (Pending evaluation by 3 bilingual human reviewers)  
**Target Specs**: 30 passages / chapters, 3 bilingual reviewers (native English proficiency + deep familiarity with Korean serialized webnovels)  
**Evaluation Scales**: Blinded 1–5 ratings on two primary axes, supported by four structural rubrics and freeform qualitative feedback.

---

## 1. Evaluation Rubrics

### Scale 1: English Readability & Natural Prose (1–5)
- **Score 1 (Unnatural / Machine-Translated)**: Broken syntax, mechanical literalisms, jarring register shifts, repetitive vocabulary, un-idiomatic phrasing.
- **Score 2 (Awkward English)**: Grammatically passable but stiff, reads like word-for-word translation, unnatural dialogue pacing, frequent calques.
- **Score 3 (Competent Standard)**: Clear and fully legible English; standard genre prose; minor clunky metaphors or rhythm dips that do not impede comprehension.
- **Score 4 (Fluent & Immersive)**: Polished contemporary English genre prose; natural syntactic variety; strong narrative flow, clear sentence momentum.
- **Score 5 (Exceptional Stylization)**: Native-grade literary polish; evocative sensory details, rhythmically sharp dialogue, effortless pacing.

### Scale 2: Korean Webnovel (KWN) Tradition & Convention (1–5)
- **Score 1 (Tradition Ignorant / Westernized)**: Reads like Western tabletop fantasy; fails to deliver core webnovel hooks; improper status notifications or honorific flattening.
- **Score 2 (Shallow Trope Dressing)**: Superficial references to ranks/dungeons without the Korean webnovel pacing, emotional escalation (사이다 / cidery catharsis), or register dynamics.
- **Score 3 (Acceptable Serial Style)**: Accurately preserves Korean serialized webnovel conventions (sentence-paragraph rhythm, quick hooks, clear power progression, proper rank tiering).
- **Score 4 (Authentic KWN Experience)**: Strong webnovel rhythm; tight scene escalations, authentic protagonist agency (사이다 balance), faithfully rendered systemic mechanics.
- **Score 5 (Exemplary Genre Synthesis)**: Perfect realization of modern Korean serialized fiction in English; seamless integration of status elements, honorific nuances, and tense scene turns.

### Supporting Diagnostic Rubrics

#### A. Continuity & Canon Consistency
- **Pass**: State-at-time, inventory, health, abilities, relationships, and chronological timelines are strictly maintained without contradiction.
- **Flag**: Inconsistencies in character knowledge, inventory disappearance, or unearned power-tier shifts.

#### B. Typography & Formatting
- **Standard**: Clean em-dashes (`—`), smart typographical quotes (`“ ”`, `‘ ’`), no double spaces, single blank lines between paragraph blocks, NFC unicode normalized.

---

## 2. Blinded Passage Samples (Excerpt Selection)

### Sample 01-A (Code: `KWN-2026-03-A`)
**Genre**: Hunter / Dungeon Gate Regression  
**Narrative Role**: Chapter 1 Opening & Status Awakening  

```markdown
“Step onto the plate, Porter Kang,” the technician said, barely glancing up from his terminal.

The air inside the Association’s Mapo branch measurement hall smelled of ozone and damp linoleum. Three days had passed since the basement gate collapse, and my shoulder still burned beneath the cheap nylon of my jacket.

Last time, this was where it ended.

In the first life, I had stood on this identical brass circle, prayed for an E-rank combat license, and walked out with an F-rank auxiliary seal. Ten years of carrying luggage for raid parties that wouldn't look me in the eye. Ten years before the dragon's breath swept the staging area in Busan and turned my bones to ash.

“Any day now, Kang Do-yoon,” the technician muttered, clicking a ballpoint pen. “There are eighty people behind you.”

I stepped onto the brass plate. Cold rushed through the soles of my combat boots.

The brass hummed. Deep beneath the measurement floor, the mana crystal turbine whined into gear, a mechanical pitch climbing until it rattled in the teeth.

[Beginning Awakener Re-Evaluation.]
[Subject: Kang Do-yoon.]
[Measuring core mana density...]

The needle on the analog dial jumped past F. It shuddered at E, flickered toward D, and then violently slammed back into the zero pin.

A thin wisp of acrid white smoke curled from the base of the pedestal.

“Faulty sensor,” the technician sighed, reaching for a reset key. “Step down and wait for the technician—”

A blue phosphor rectangle cut through the smoke, floating four inches from my retinas. It didn't look like Association firmware. There was no bronze insignia, no serial registration number, no department stamp.

[Anomalous Resonance Detected.]
[Synchronizing soul imprint with terminal timeline (Iteration 02)...]
[Class designation unlocked: Soul Scribe (Mythic).]
```

### Sample 01-B (Code: `KWN-2026-03-B`)
**Genre**: Hunter / Dungeon Gate Regression  
**Narrative Role**: Chapter 1 Opening & Status Awakening  

```markdown
The technician clicked his pen impatiently. “Kang Do-yoon, get on the measurement disc.”

Do-yoon moved forward onto the cold bronze circle in the middle of the room. The Association room was noisy with people waiting for their rank cards. He remembered this day ten years ago when he was told he had an F-rank and could only be a porter.

The machine started vibrating. 

“Hurry up,” the man behind him said.

[Player evaluation in progress.]
[Mana quantity: Very Low.]
[Rank: F.]

Then the machine made an error sound and sparkled with blue lightning. The operator frowned and hit the console with his palm. “What is wrong with this old model?”

In front of Do-yoon, a transparent box appeared that nobody else seemed to notice.

[Error in history timeline.]
[Restoring previous life memories and hidden skills.]
[Unique Class granted: Soul Scribe.]
```

---

## 3. Reviewer Score Form

**Reviewer ID**: `[ Blinded Reviewer #1 / #2 / #3 ]`  
**Date**: `_______________________`  

| Sample Code | Natural English (1–5) | Korean Webnovel Tradition (1–5) | Continuity / Canon Flag | Freeform Qualitative Comments |
| :--- | :---: | :---: | :---: | :--- |
| `KWN-2026-03-A` | `[   ]` | `[   ]` | `[ Clean / Flag ]` | |
| `KWN-2026-03-B` | `[   ]` | `[   ]` | `[ Clean / Flag ]` | |
| `KWN-2026-04-A` | `[   ]` | `[   ]` | `[ Clean / Flag ]` | |
| `KWN-2026-04-B` | `[   ]` | `[   ]` | `[ Clean / Flag ]` | |
| `KWN-2026-05-A` | `[   ]` | `[   ]` | `[ Clean / Flag ]` | |
| `KWN-2026-05-B` | `[   ]` | `[   ]` | `[ Clean / Flag ]` | |

**Reviewer Certification**:
> *"I certify that I have judged these blinded passages independently without prior knowledge of system provenance, model origin, or variant assignments."*
