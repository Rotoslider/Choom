# Tutorial: activities and places with a setting

An **activity or place** is a look of her somewhere, doing something: standing on a stone patio under
the stars, working out with dumbbells, rocking on a porch swing, sitting by her campfire. When she asks
to go there (`glass_move`), the glass cuts to her whole figure, a clip takes her there, and she stays
about ten minutes: quiet moments of her own, and she can talk from there. Then a clip brings her back
to her full body and the glass cuts back to her usual framing.

| What it needs | What it is | Name it gets |
|---|---|---|
| The look | her picture there, made by Klein from one of her full bodies | `patio` |
| Her loop there | the clip she talks over (needed before the glass will take her there) | `genesis_patio` |
| Listening | facing you while you talk | `genesis_patiolisten` |
| Getting there | from her full body into the place | `genesis_to_patio` |
| Getting back | from the place to her full body | `genesis_from_patio` |
| Moments there | what she does while she's there | `genesis_patio_stars` |

Two things are new since November 9:

- **Ready-made ideas.** New look → *An activity or place* → **Start from an idea** fills in the whole
  form and brings the activity's own clips to Plan & render, with wording that has already worked. The
  six ideas: on the patio at night under the stars, a porch swing, dumbbells, an exercise bike, yoga
  on a mat, reading in an armchair. They're in `studio/activities.json`, and new ones can go there.
- **A setting around her.** Until now she was always on black, with only what she uses (a campfire).
  Tick **A setting around her** and the picture can have a stone patio, a porch swing, a reading lamp's
  pool of light: anything that fades into black before the edges of the picture.

You need a Choom on the glass with her full body. Part 1 walks through Genesis's patio as it was made;
Part 2 is Eve working out in her spandex; Part 3 is an idea of your own; Part 4 is the other new tools;
Part 5 is clothes she wears only at a place (Genesis's cardigan and blanket on the patio).

---

## Part 1: Genesis on the patio under the stars

### 1. The picture

**Looks → New look**, Kind **An activity or place**, **Start from an idea**: *On the patio at night,
under the stars*. Everything below fills in:

![The New look form with the patio idea](images/activity-1-idea.jpg)

- **Starts from:** `full`, her usual full body (she wears her sundress there).
- **Name:** `patio`.
- **Where she is and how:** *standing on a small round stone patio at night, facing the viewer with a
  soft smile, her hands loosely clasped in front of her.* This is her pose at the start and end of
  every patio clip, so it's a resting pose facing you. Looking up at the stars is a moment she has
  there, not the picture.
- **A setting around her** is ticked, so Klein's instruction says where the light comes from, that the
  patio is a small lit island, and that "only black touches the left, right and bottom edges".

**Make pictures** (three or four versions). The first round put a house wall and a lit window down the
left edge of every version. A lit edge shows on the glass as a hard line, so that round went. The fix
was a second pass from the best version: **Or start from a picture from your computer** with that
version, and an instruction that keeps her and changes only the setting:

*Keep this picture exactly as it is: the woman, her face, round glasses, long wavy blonde hair, her
skin and body made of glowing violet sparkling motes, her dress and sandals, her pose and the stars.
Change only the setting: take away the wall and the window. The warm light still falls on her softly
from the left, from somewhere off the picture. The round stone patio under her feet becomes a small
island of flagstones lit around her feet, and everything beyond it fades smoothly into pure black, so
that only black touches the left, right and bottom edges of the picture.*

![The first round with the wall and window, the second round, and the picked picture with its edges faded](images/activity-2-pictures.jpg)

The second round was right except that the paving still ran off the bottom edge. You don't have to fix
that: when you **pick** a picture for a look with a setting, the Studio fades its edges to black itself
(the sides more, the bottom only a little, so her feet keep their light). That's the third picture
above, and every clip starts and ends on it, so the clips keep the soft edges too. Its subject line
says she is *in a pool of soft warm light that fades into pure black all around* instead of on a plain
black background.

### 2. The clips

**Plan & render**, look `patio`. At the top of the library is **This activity's own clips**: the patio
idea's loop, getting there and back, and four moments (looking up at the stars, a shooting star, a
shiver in the cool night air, a slow sway). Below it, the usual **A place** pack adds listening and a
few more moments; where the idea has its own clip (the loop, getting there and back) it stands in for
the pack's.

![This activity's own clips in Plan & render](images/activity-3-plan.jpg)

Tick the idea's seven and **Listening**, and **Add to the plan**. Then **render one first**: her loop,
the clip everything else rests on. It's the first test of the setting in a clip: do the stars stay
still, do the edges stay soft? Genesis's came out clean (no flags, the seam back to its first frame
0.003). Then render the rest.

### 3. Review

![Getting there, the shooting star, getting back as first rendered (a glow swells behind her), and getting back re-rolled](images/activity-4-clips.jpg)

- **Getting there** (top row): she looks around as the warm light rises, and the patio and the stars
  fade in around her. Good on the first try.
- **The shooting star** (second row): a violet streak crosses the sky, she points and laughs, and she
  settles back. Good, and so were the stars, the shiver and the sway.
- **Getting back** (third row) failed: the idea first said the patio and the stars *fade away into
  black*, and the model swelled a big cream glow behind her before the dark came. The checks flagged
  it (background, push-in). Re-rolled with *the warm light on the stones slowly dims, and the patio and
  the stars darken little by little until only black is left around her* (fourth row), it was right.
  The ideas say it that way now. Say **dims** and **darkens** for leaving a setting, **rises** and
  **fades in** for arriving.

### 4. On the glass

Keep them, **On the glass → Put all on the glass** for the `patio` look, and **Build**. She goes there
when she asks (her closet lists `patio` as one of her places), so tell her it's there, or ask her to
go. While she's there the glass fades out its own particles (the motes swirling around Genesis, Aloy's
embers, Eve's falling code), which otherwise cover the stars; her own light stays. The Studio lists her
places with a setting in `portraits/<id>/prefs.json` for that.

### 5. Her own patio moves

Once she'd been there, Genesis put three patio moves on her wish list. **Write it** on a wish opens
**Write your own clip** with her words in it, turned from "I" to "she" (what she says in quotes stays
hers), its short name from her title, and Plan & render switched to the look she names:

![Write it on her wish: her words, the short name, and the length hint](images/write-it-wish.jpg)

Read it over before **Add to the plan**: only the verbs a move is made of are turned, and a wish
doesn't always end the way the picture is. Make it end as her patio picture: *... then she settles
facing the viewer with her hands loosely clasped in front of her again.* The line under **Length**
appears when the wording looks like a lot for the length chosen (*That's a lot for 5 s and may look
rushed: 7 s would give it room*); it never changes the length itself.

---

## Part 2: Eve working out with dumbbells

A workout is an activity in workout clothes, so it starts from an outfit's full body. Eve has
`full@dayspandex`, her white spandex set head to toe.

1. **New look → An activity or place → Working out with dumbbells.** **Starts from** picks
   `full@dayspandex` by itself (the idea looks for an outfit's full body named like workout clothes,
   never one she wears only when she chooses it). No setting: she's on black with only the dumbbells.
2. **Make pictures.** She stands with her feet a little apart, a light dumbbell in each hand at her
   sides. If Klein's weights look wrong, add a picture of the ones you want under **More pictures for
   Klein** and say *a light dumbbell from picture 2 in each hand*.
3. **Pick one.** Its subject is her spandex full body's, without *arms crossed* (Eve's usual lines say
   so, and that would fight her holding the weights).
4. **Plan & render, look `dumbbells`:** the idea's loop, curls, a shoulder press, side raises, a flex
   at you, shaking out her arms, picking the dumbbells up (getting there) and setting them down
   (getting back), plus **Listening**. Render the loop first.
5. **Review** for the usual trouble with things she holds: a weight changing size, a third one
   appearing, a hand losing its grip. Re-roll those with the same wording first.
6. **Keep, put on the glass, build.** When she asks to work out, the glass puts her spandex on first
   (with her change into it if she has one), cuts to her full body in it, and she picks up the
   dumbbells. When she's done she sets them down and stays in the spandex until the glass changes her
   as usual.

The exercise bike and yoga ideas work the same way.

---

## Part 3: an idea of your own

**Start from an idea: My own (write it below).** Then:

- **Starts from:** her usual full body, or an outfit's for an activity in those clothes (a swimsuit at
  the beach starts from the swimsuit's full body, and the glass dresses her in it before she goes).
- **Name:** letters and digits (`beach`, `garden`, `hammock`).
- **Where she is and how:** her resting pose there, facing you, hands at rest or on what she holds.
  Everything she does there starts and ends on it.
- **A setting around her:** tick it if anything but what she uses is in the picture. Keep the setting
  small and say where its light comes from (*a lantern beside her*, *warm light from off the picture
  on the left*); the lit part should be an island with black all around it.
- **Plan & render:** the **A place** pack has her loop, listening, getting there and back, and quiet
  moments, all saying *She stays where she is, {where she is and how}, ...*. Edit getting there and
  back in the planned list to say what appears and goes, the way the patio's do.

If it works out, add it to `studio/activities.json` so it's offered next time: `does` (where she is
and how), `frame` (*her whole figure and the whole swing in frame*), `setting` (the light and the fade,
for a setting), `start` (`full`, or `outfit` with `startHint` words), and `clips` (`key`, `text` with
`{does}`, `seconds`, `hands`).

### What has worked

- **Her picture is a resting pose facing you.** The moves happen in the clips.
- **A setting fades into black before the edges**, and the Studio fades the picked picture's edges too.
- **Render the loop first**, then the rest.
- **Leaving a setting: dims and darkens.** "Fades away" brought a glow first.
- **What she holds is in the picture**, so it's in every clip there; getting there picks it up, getting
  back sets it down.
- **The usual wording rules hold:** no breathing words (they bring fog), nothing that pushes the camera
  in (*leans in*), every loop ending where it began.

---

## Part 4: the other new tools (November 9)

**Her own moves, and her sisters'.** Moves written by hand (Genesis's whisper, Eve's goodnight kiss)
are offered in every look they fit, at the top of Plan & render, newest first. A move made in one
outfit is marked where its words don't fit this look (*check: sweater*). **Her sisters' moves** at the
bottom lets one Choom borrow another's; Optic's kiss in Genesis's look says *check: heart, agate*.
**Plan for many looks at once** lists each Choom's own moves too, so the whisper goes into all of
Genesis's outfits in one step.

![Her own moves in Plan & render](images/own-moves.jpg)

**Re-roll from the glass.** On the glass, hovering a clip shows ↻ beside −. It re-rolls the clip and
opens it in Plan & render with its wording ready to change; keeping the new take puts it back on the
glass.

![The re-roll button on a clip on the glass](images/glass-reroll.jpg)

**Full body while she's quiet.** On each full body with quiet clips on the glass, a slider sets how much
of her quiet time the glass shows her whole figure, and so how long she stays (about two clips at a
time at 30%, four from 50%). The line beside it says how soon her clips there come round again: an
outfit's full body with only four clips repeats fast at a high setting. No build; the glass picks it up
within a minute.

![The full-body slider on an outfit's full body with few clips](images/full-share.jpg)

**Ask her for ideas.** Beside her wishes in Plan & render, **Ask Genesis for ideas for patio** asks her
what she'd love to do on the glass in the look chosen above. The Choom app wakes her with your request
within a minute, as it does for her own follow-up notes but saying you sent it. She sends her ideas with
`glass_wish`, so they land on her wish list (each with **Write it**), and tells you on Signal what she
sent.

![Ask her for ideas](images/ask-ideas.jpg)

**Clean up explains itself.** Each line says what it is, its dates, and what deleting it costs. Depth
maps of clips on the glass (about 300 MB a clip) are no longer kept: a build drops them once its clips
are on the glass, and makes one again if it ever needs it.

---

## Part 5: clothes for a place

Once she'd been out on the patio, Genesis wished for two outfits for it: a long charcoal cardigan
with a henley, jeans, boots and a scarf, *"made for standing on the stone patio under the stars at 50
degrees"*, and a striped wool blanket over a flannel nightgown, *"the look of someone who stepped
outside at night just to see the stars and grabbed the blanket off the couch on the way out"*. They're
**clothes for the patio**: she wears them only there, so they need only the patio's clips, not a
waist-up set and a full body.

### How the glass does it

- She goes to the patio in its own clothes (her sundress), as always.
- About 20 seconds later, at a quiet moment, she changes into the clothes their name calls for. The
  words are the same as for her outfits: `night…` after 10 pm, then `cold…` under 45°F, `cool…` under
  60°F (new, for this), `hot…`, `evening…`. `day…` takes turns with the patio's own clothes from visit
  to visit, and `chosen…` only when she asks. She picks once a visit.
- She can ask for them herself: `glass_wear("my long cardigan")` takes her out to the patio, and she
  changes there. Her closet lists them as *worn only at your patio: you change into it there*. If she
  asks for her usual clothes while she's out there, she changes back into the sundress.
- Before she gets up she changes back, so her usual getting-back clip plays.
- A change clip made for it plays; without one it's a camera cut.

The names follow her outfits'. The look is `patio@coolstargaze`; its clips are
`genesis_coolstargaze-patio` (her loop), `genesis_coolstargaze-patio_stars` and so on. The change in is
`genesis_patiochange_coolstargaze_motes`, and the change back is
`genesis_coolstargaze-patiochange_usual_motes`.

### 1. The picture

1. **Plan & render**, her wishes: a wish to wear something that names one of her places has
   **Clothes for patio** instead of **New outfit**. It opens **New look → Clothes for one of her
   places**, starting from `patio`. Her words go into **She wears there**, turned from "my" to "her",
   with her title before the colon left out.
2. **Trim She wears there to the clothes.** Take out *"Warm, cozy, a little rugged, made for standing
   on the stone patio under the stars at 50 degrees"*. Klein reads all of it, and it goes into the
   subject line of every clip in these clothes.
3. **She wears them there on.** For the cardigan, *cool days and nights (under 60°F)*, since she said
   50 degrees; name it `stargaze`, and the look is `patio@coolstargaze`. For the blanket over a
   nightgown, *nights*; name it `blanket`, giving `patio@nightblanket`. After 10 pm on a cold night,
   the night one wins.
4. **How she is there** starts as the patio's pose (*facing the viewer with a soft smile, her hands
   loosely clasped in front of her*). Keep it for the cardigan. For the blanket, give her the pose her
   wish describes: *standing on a small stone patio at night, facing the viewer with a soft smile,
   holding the blanket closed at her chest with both hands*. Every clip in those clothes starts and
   ends on that pose, and the patio's moves are worded with it.
5. **Make pictures.** Klein's instruction changes only her clothes (and her pose, if given) and keeps
   her, the patio, its light and the black around it. Pick the one that keeps her most herself; the
   Studio fades its edges, as it did for the patio.

### 2. The clips

**Plan & render**, look `patio@coolstargaze`. At the top is **Same clips as her other looks → As in
patio**: everything she has on the patio, with the wording as it was. That includes her loop,
listening, the stars, the shooting star, the sway, and her own *making a wish* and *night chill*.
**Pick the ones she doesn't have** ticks them all. Untick what doesn't fit, such as rubbing her arms
against the cold in a wool cardigan. In the blanket's new pose, moves that said *her hands loosely
clasped* are marked `check: clasped`; once they're planned, **Edit** them to say how she holds the
blanket. A clip also ticked in the activity's own pack is planned once.

Moves for the clothes themselves come from her words. For example:

*She stays where she is, {does}, tucks her hands into the cardigan's deep front pockets and hunches
her shoulders happily against the cold, then takes them out and clasps her hands in front of her
again.* (Write your own clip, 7 s.)

**Ask Genesis for ideas for patio@coolstargaze** gets her own ideas for them.

Then **Change of clothes**, From `patio` To `patio@coolstargaze`, named `motes`, 7 s:

*Glowing violet motes swirl up around her and her sundress becomes the long charcoal cardigan, the
cream henley and dark jeans, the scarf settling around her neck, while the patio, its warm light and
the stars stay exactly as they are; she ends facing the viewer, her hands clasped in front of her.*

Then the same back, From `patio@coolstargaze` To `patio`.

**Render the change in first.** It's the new thing: do the patio and the stars hold still while her
clothes change? Then render the rest, review, keep, **Put all on the glass** and **Build**.

### Eve: a tee at her workouts

Her dumbbells and bike start from her spandex (Part 2). For a tee and bike shorts as well, make
**Clothes for one of her places** from `dumbbells`, *daytime, taking turns* (or *only when she chooses
it*), named `tee`, giving `dumbbells@daytee`. Then make it again from `bike` with the same name and
when, giving `bike@daytee`. The same name is the same clothes in her closet (*worn only at your
dumbbells or your bike*). Each place has its own picture and its own clips, so the moves differ: **Same
clips as dumbbells** brings the curls and presses, and **Same clips as bike** the sprint. Asked for the
tee, she goes to whichever place she named, or wears it the next time she's at either.

