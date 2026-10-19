# Glass Studio

Glass Studio makes and manages everything that brings a Choom to life on the Looking Glass Portrait:
her pictures, her outfits, and the short clips she plays. It plans clips from a library of actions
that work on the glass, renders them with Wan2GP, checks each one for the usual failures, lets you
keep or drop them, and builds her chosen clips onto the glass. It also brings new Chooms to the glass.

![On the glass: Optic's clips, look by look, with a clip's description on hover](docs/images/glass.jpg)

Open it at **http://127.0.0.1:8767** on the computer the Portrait is plugged into. `launch.sh` starts
it with the hologram (set `HOLOGRAM_STUDIO=0` to skip it), and Choom's Settings → Camera links to it.
To run it on its own, from the hologram folder: `python3 studio/studio.py serve`. Every button and
field explains itself when you hover over it.

**Tutorials**
- [Your first Choom on the glass](docs/tutorial-new-choom.md): from a fresh install to a Choom living
  in the glass, with her own moves.
- [A new outfit for a Choom you have](docs/tutorial-outfit.md): her picture in new clothes, its clips,
  its full body, and onto the glass.

## How a Choom is made

A Choom on the glass is a set of short clips that all start and end on the same picture of her, so
the glass can play them in any order without a seam. Each clip has depth on every frame, so she
stands in the glass in 3D, and her lips follow her voice over any clip she talks in.

- **Looks.** A look is one picture of her, named `<pose>` or `<pose>@<outfit>`:
  - her main pose (`main`), and a second waist-up pose if she has one (Aloy's hand-down `relaxed`)
  - outfits in a waist-up pose (`main@evening`, `relaxed@cold`)
  - other looks in her usual clothes (Genesis without her motes, `main@plain`)
  - full body (`full`), and an outfit's own full body (`full@dayspandex`)
  - asleep (`asleep`), and asleep in a night outfit (`asleep@nightcold`)
  - places, named by you: somewhere she goes and stays a while (Genesis's `campfire`, sitting on the
    ground by a fire), framed wide like her full body
  - the empty glass (`gone`), a black picture she walks off into and on from
- **Clips.** A clip's name says what it's for, using the roles in `tools/clip_roles.py`:
  - `idle_glance`: a quiet moment
  - `listen`: listening
  - `talk_nod`: a calm loop to talk over
  - `pose_wink`: a move for a selfie
  - `evening-idle_glance`: the same quiet moment in her evening outfit
  - `eveningdress-change_nightcold_melt`: a change of clothes on screen, from one look to another
  - `campfire`, `campfire_glance`, `campfirelisten`: her loop at a place, a quiet moment there, listening
  - `to_campfire`, `from_campfire`: sitting down there from her full body, and getting up again
  - `walkoff`, `walkon`, `vanish`, `appear`: off the glass and back on, from her full body (walking)
    or her waist-up look (vanishing)

  The Studio names the clips it plans, so you never have to.
- **Her project file** (`studio/<id>.json` in the workspace) keeps every look and every clip, with its
  prompt, seed, status and older takes, plus her sequence: the list of clips on the glass, her main
  idle first.

A clip moves through five statuses: **planned**, **queued** (in a render), **rendered** (waiting for
review), then **kept** or **dropped**. Only kept clips can go on the glass.

## The page

Each Choom has a button at the top. The number on it is how many clips her glass plays now; it
changes when a build finishes, not when you place clips. Under her name, a line sums her up: clips on
the glass (and how many once the waiting changes are built), looks, clips to review, planned and
rendering. **Work** at the top right is the work list. The address keeps the view
(`#genesis/review/kept`), so a view can be bookmarked or reloaded.

### Review

![Review: a new clip flagged by the checks, with what the flag means](docs/images/review.jpg)

Every new clip arrives as a contact sheet, eight frames from first to last; click it to watch the
clip. The automatic checks flag the ways clips go wrong on the glass:

| Flag | What it means |
|---|---|
| **background** | the black around her lifts: fog, a glow, a flash |
| **push-in** | she grows in the frame: the camera moved |
| **color** | her light or colour drifts (sometimes on purpose: Genesis's motes fading) |
| **seam** | the last frame doesn't come back to the first |
| **cut** | a sudden jump: a new shot |

The limits were set on the four Chooms' first 784 clips: they flag 38 of the 46 clips dropped by
eye (the other 8 were dropped for taste) and about 5% of the keepers. Clips that move a lot on
purpose (full body, wind, particles, a look changing on screen) are checked with looser limits.
A clip that walks on or appears from the empty glass is measured backwards, against the frame she's
in. Clips on or off the glass skip **color** and **cut**, because she goes to black on purpose.
Going to or from a place skips **color**, because the light on her changes (a fire flickering up).
About one clip in six fails, so watch them all.

- **Keep** (K), **Drop** (D) or **Re-roll** (R). Space plays the clip; the arrow keys move between
  cards. The note field records why a clip was dropped or what to fix.
- **Re-roll** puts the clip back in the plan under the same name with a new seed. You can change its
  wording or length there before rendering it again. The old take is kept in the clip's history and
  its file in `clips/takes/`.
- **Earlier takes** shows on a re-rolled clip's card once the new take has landed: **▶** watches an
  old one, **Use it** brings it back. The old take becomes the clip again, with its seed, status
  (kept, dropped or to review) and note, and goes back on the glass if it was on the glass when it
  was re-rolled. The take it replaces moves to the earlier takes in its place, so you can swap back.
  Its sheet is made again, and its file counts as new, so the next build remakes its depth and
  cut-out. Before the re-roll has rendered, **Keep the old take** in Plan & render does the same.
- After **K**, **D** or **R** the keyboard stays on the next card, and a refresh while you work
  (a render landing a clip) keeps the card you're on and leaves a note you're typing alone.
- The filters show what is **To review**, **Flagged** (rendered and kept clips the checks were unsure
  about), **Kept**, **Dropped** or **All**, for one look or all of them.
- **Make missing sheets** makes sheets and checks for clips that have none.

![The Flagged filter on Aloy's kept clips](docs/images/flagged.jpg)

### On the glass

Each look lists its clips on the glass and its kept clips that aren't, with how many minutes of
quiet moments she has in it before one repeats.

- Drag a clip in to add it, out to take it off, or onto another to swap them. Her main idle always
  stays first.
- Or tap the **+** on a clip to put it on the glass, **−** to take it off (it shows on hover, and
  always on a phone or tablet, where there's no drag and drop).
- **Put all on the glass** adds a look's kept clips at once.
- Hover over a clip to play it; double-click to watch it large.
- The bar at the top says what changed since the last build, and anything that has to be fixed
  first: every waist-up look on the glass needs a loop she can talk over (its base loop), and every
  clip needs its file.
- **Build and put on the glass** makes cut-outs, depth and reliefs for the new clips only. The glass
  reloads at its next quiet moment (no Choom talking), and after that the videos and caches of clips
  that aren't hers any more are cleared away. A build can also wait: **Schedule** builds at a time
  (11 pm, say), and **After the render** builds as soon as the render waiting or running now has
  finished. A build reads her sequence when it starts, so there is never more than one waiting build
  per Choom: clicking again while one waits adds nothing (a new time replaces the old one), and changes
  made while a build runs go into the next one.
- **Home pose** (for a Choom with a relaxed look): the pose she falls asleep from, wakes into and
  changes clothes in. Aloy's is relaxed, hand down. It's kept in her project (`"home"`); clips planned
  from then on take it, and the next build puts it on the glass.

An outfit can only be worn once its waist-up look has a loop she can talk over on the glass. Its full
body (`full@<outfit>`) plays only while she wears the outfit, so build the outfit's waist-up clips
before or with its full-body clips.

Under each look's name a line says how far it is from the glass: kept clips, how many are placed,
how many a build still has to make, and for an outfit whether it has a talk loop placed and about how
long the build of its new clips takes (about 2.5 minutes a clip). The bar warns about the two easy
misses, each with its fix:
- **a look whose kept clips are none of them on the glass** (`main@dayshop: 49 kept clips, none on
  the glass yet`), with **Put them on the glass**;
- **an outfit's full body or asleep look on the glass while she can't wear the outfit**, because its
  waist-up look has no talk loop placed: those clips would never play.

The same line shows on each look's card under Looks.

### Plan & render

![The clip library for a new outfit, with Essentials and eight quiet moments ticked](docs/images/outfit-4-plan.jpg)

Choose a look and pick actions from the library; the packs shown are the ones that suit the look.
Clips she already has are marked, and **Pick the N she doesn't have** ticks the rest of a pack.
Actions marked **uses a hand** need a word about how she frees the hand and puts it back if her pose
holds something (Optic's heart, crossed arms).

| Pack | What's in it |
|---|---|
| Essentials | the loop she talks over, listening, thinking, a long calm loop, a smile, three talking loops |
| Quiet moments | about 40 small things she does while nobody talks |
| Expressions | happy, surprised, sad, concerned (main look and outfits; an outfit without them borrows its nearest smile, raised brows or head tilt) |
| Oops | her face at her own mishap |
| Sleep | dozing off, sleeping, waking, a yawn; needs an asleep look; offered for night outfits too |
| Windy days | her hair and clothes in the wind, on windy days only; each outfit needs its own |
| Selfie moves | look-at-me moves for a picture she made (her usual looks and outfits; an outfit without them has only its full body's moves, if it has a full body) |
| Full body | moves and twirls for a full-body look |
| Big moves | longer full-body moves, 7 to 15 seconds: dances, turning her back to you, a curtsy, tai chi |
| Picture looks | turning to a picture beside her (usual looks and outfits; an outfit without them glances its way with a quiet clip) |
| Pose changes | moving between her two waist-up poses; shown only for a Choom with a second pose (Aloy's `relaxed`), which the Studio can't make yet |
| A place | in a place look: her loop there (she can talk in it), listening, quiet moments, and the clips to sit down from her full body (`to_`) and get up (`from_`); edit those two to say what appears and goes (the fire flickering up as she sits) |
| Walking on and off | in her full body (walk off, walk on) and main look (vanish, appear), once she has the empty glass; her usual clothes only |
| Campfire circle | in a seat look (`circleside`, `circle`): her loop to talk over, listening (toward the middle; a facing seat each way), and quiet moments by the fire (warming her hands palms down, a sip from her mug). Everyone in a group room needs at least the loop for the room to sit around the fire |

**Plan for many looks at once** plans the same library actions in many looks in one step, for
instance Expressions and Oops in every outfit. Tick actions (a pack's box ticks all of it) and looks
(**her outfits** and **every Choom's outfits** tick the waist-up outfits), then **Preview**: each
look shows how many clips it would get, how many of those actions it already has, and any it can't
have yet for want of a picture, with the total and its render time. Nothing is planned until you
click **Plan N clips**. A look never gets an action it already has (no numbered copies), so planning
the same set again plans only what's new. The clips then sit in each Choom's Planned list; render
them from there.

**Write your own clip** takes any move that ends where it began: a dance, turning her back to you and
turning around again, a kiss. Choose what the glass uses it for (quiet moment, look-at-me move,
talking loop, oops face, or **Windy day**, which plays only when it's windy) and a length of 5 to 15
seconds.

![Writing your own clip: a ten-second dance](docs/images/custom-clip.jpg)

**Change of clothes** plans a clip from one waist-up look to another in the same pose, rendered from
the first look's picture to the second's (`genesis_eveningdress-change_nightcold_melt`). The glass
plays it instead of the camera cut when she changes between them. Make one each way (into her night
look, and back to her usual clothes for the morning). One motion in five to seven seconds works
best, and a change by magic renders more reliably than clothes moved by hand.

![A change of clothes from the burgundy dress to the cold-night look](docs/images/change-clip.jpg)

Each prompt is built from the look's subject line, its keep line, the action, the camera line and the
loop ending. Wording that has gone wrong before gets a warning:
- naming an effect you don't want
- breathing words, which bring fog
- "leans in", which pushes the camera in
- camera words outside the camera line

The planned clips are listed on the right. **Edit** changes what a clip does and how long it is
(5 to 15 seconds); its prompt is rebuilt from the look. **Remove** takes it out of the plan, and on a
re-roll **Keep the old take** goes back to the take she had.

![A planned re-roll opened for editing, with its length](docs/images/planned-edit.jpg)

Then **Render now**, or **Schedule** it for a time (23:00 unless you change it). The glass runs
slower while the GPU renders. Each clip shows up in Review as soon as it lands, with its sheet and
checks, while the rest keep rendering.

### The work list

![The work list: a render running and another waiting for 11 pm](docs/images/outfit-6-rendering.jpg)

Everything the Studio does runs as a job in one of three lanes:

| Lane | Jobs | |
|---|---|---|
| GPU | renders, Klein pictures, builds, a new Choom's still relief | one at a time, in order |
| CPU | contact sheets and checks | beside whatever the GPU is doing |
| Glass | reloading the glass after a build | waits for a quiet moment |

A scheduled job shows what it waits for ("waiting until 11:00 PM", "waiting until the render has
finished"). Waiting, running and paused jobs stay at the top of the list, above the finished ones. The
pill in the corner says what's happening: rendering 12/44, building, pausing, paused.

**Cancel** stops a job. The tool it runs is stopped (asked first, then made to stop if it hasn't within
30 seconds), and the lane stays taken ("stopping…") until it really has, so nothing new starts beside
it on the GPU. Cancelling a render puts the clips it hadn't rendered back in the plan.

**Pause** (in the work list's header) pauses the work list. It can't stop a tool halfway without
losing its work, so it says what will happen first and waits for the item that's running to finish:

- **A render** stops once the clip it's on has landed. Its other clips stay queued in the paused job.
- **A build or Klein pictures** finish, then the GPU lane holds.
- **Nothing more starts on the GPU** until you press **Resume**, even when a scheduled time comes; the
  checks of clips already made carry on.

A banner across the page says pausing or paused. **Resume** carries on: a paused render goes on from
the clips it hadn't rendered (as a new queue, `<name>-r2`), after anything queued while it was paused.
So to try something mid-render, pause, queue it (Klein pictures, a few clips), and resume: it goes
first. The pause is kept in `studio/worklist.json`, so it outlasts a restart of the Studio.

**Reloading the glass** after a build is a job of its own. It waits up to ten minutes for no Choom to
be talking; if the glass stays busy (a room the Chooms run at night, say), it tries again five minutes
later, instead of failing the build. Several builds share one waiting reload. Once the glass has
reloaded, `make_alive.py --prune` deletes the old videos, and the cut-out and depth caches of clips
she no longer has (dropped ones, ones re-rolled away).

Jobs are kept in `studio/jobs.json`, and every tool runs in its own session with its process kept in
its job, so jobs survive a reload of the page and a restart of the Studio:
- **A render, a build or Klein pictures keep going** while the Studio is down, and it watches them again
  when it restarts (it checks the process really is that tool before trusting it).
- **A build picks up at the step it was on** (that step runs once more and only redoes what didn't get
  done). A build's output goes to `studio/logs/build_<choom>.log`.
- **Klein's pictures arrive in the look's versions as usual.** If Klein never started, its versions are
  marked failed rather than left "making".
- **A render that finished meanwhile** counts as done if every clip arrived.
- **A render paused partway** stays paused.

If Wan2GP ever writes videos the Studio can't match to a clip (its naming changed, say), the render
fails and names the files instead of quietly planning the clips again.

**Clean up…** (in the work list's header) shows disk use and what nothing uses any more:
- videos of dropped clips
- old takes older than a number of days
- Klein versions no look is waiting on
- finished render queues
- cut-out and depth caches of clips she no longer has (about 230 MB a clip)

Tick what to delete; a second click confirms. Never deleted: anything a kept, planned, queued or
rendered clip uses, a look's picture, versions a look is waiting on, or a queue a job still uses.

**A morning summary on Signal** (optional): when a scheduled render or build, or a run of them, has
finished or failed, the Studio sends one short message through the Choom app, in one Choom's Signal
thread. It lists what ran (a build says how many clips it put on the glass: "Build Genesis (115 new
or changed clips, 531 in all)"), anything that failed and why, what's still going as it's sent
(running, paused, waiting for another job, or scheduled for later), and how many clips wait for review
and how many are flagged. Jobs you start right away don't open a run; they're listed when they end
while a scheduled one's run is open. Anything that ends in the quiet hours (10 pm to 7 am unless you set them) waits
until they're over. Turn it on in `studio.json` (see Setup).

### Looks

![Eve's looks: each picture with the lines her prompts start with](docs/images/looks.jpg)

Each look has its picture and three lines:
- **Subject:** who she is in this look. It starts every prompt and says "a plain pure black
  background".
- **Keep line:** said in every clip of the look, like Genesis's motes staying on her.
- **Loop ending:** how she ends every loop.

An outfit's card also has its **closet words** (see [What the Chooms can ask
for](#what-the-chooms-can-ask-for)). **Save** applies the lines to clips planned from then on and to
the look's clips that are already planned; rendered clips keep their prompts. Clips already queued in a
render (a scheduled one too) keep the prompt they were queued with: Save says how many, and cancelling
that render and rendering again uses the new lines.

An outfit's card also has **She wears**: what she wears in it (from "She now wears" when it was
made; empty on looks made before that, until you fill it in). Changing it and clicking **Save** puts
the new clothes in the Subject line, unless you edited the Subject in the same save, in which case your
Subject stands. A full body made from the outfit adds what it shows below the waist to these clothes.

A waist-up look's card also has **What Klein keeps** of her (`kleinKeep`: her face, Genesis's glasses
and motes, Optic's headphones and heart), copied from the look it was made from and editable there.
New looks made from it start their prompt with that list. A full body or asleep picture adds her
clothes to it, and a full body, which stands relaxed, leaves out what the list says about her arms,
hands or pose (Eve's "her arms crossed in front of her" would keep her arms crossed in every full
body) and keeps what she holds without how she holds it (Optic's heart). The prompt is shown before
Klein runs, so either can still be changed by hand.

**Rename outfit** (on an outfit's cards) gives the outfit a new name: all its looks (`main@`,
`relaxed@`, `full@`, `asleep@`), its clips and their files in `clips/`, sheets and earlier takes move
to it, change-of-clothes clips into it too, since a clip's name says which look it's in. The name
starts with when she wears it (day, hot, evening, cold or night), so a rename can change that. It's
refused while any of its clips is queued, placed on the glass or built: take them off the glass and
build first. **Delete look** takes a look out of her project (its picture file stays in `clean/`).
It's refused for her main look and while clips that aren't dropped use it; if only dropped clips use
it, the page asks before deleting them with it. Both ask in the page before doing anything.

#### New look

**New look** makes a new picture with Flux.2 Klein, which makes a few versions; you pick one.

![The new look form for Genesis's burgundy dress](docs/images/outfit-1-new-look.jpg)

| Kind | What it makes |
|---|---|
| An outfit | her in new clothes, in the pose of the look it starts from (`main@eveningdress`) |
| Full body | her head to toe: `full` from her usual look, `full@<outfit>` from an outfit |
| Asleep | her with her eyes closed, for the sleep clips: `asleep` from her usual clothes, `asleep@<outfit>` from a night outfit |
| A place | somewhere she goes and stays a while, from her full body: name it (`campfire`) and say where she is and how ("sitting on the ground beside a small campfire, her knees drawn up and her hands held out over the flames, palms down, looking up at the viewer"). By a fire, hands warm palms down and move a little; palms up looks like holding something out (Genesis's first campfire) |
| The empty glass | a black picture for walking on and off (`gone`); made at once, no Klein |
| A seat at the campfire circle | made as A place named `circleside` (sitting, turned three-quarters toward the left of the picture: an end seat) or `circle` (facing the viewer: a middle seat), from her full body. Say "warm orange light falls on her from the lower left" but leave the word campfire out of the Klein prompt, or Klein draws a fire in (the glass draws its own); a fire that slips in comes out with a second pass on that draft ("Remove the flames and the glowing ground ...", started from the draft). Clothes can come from a picture added as a reference (her camping clothes from the trip photo). Around the fire the Chooms are realistic: every seat has natural skin (Genesis's from a pass on the draft with her plain picture as the reference; Optic's without her cyan outline or her heart), and the glass adds no motes there. A face that drifts (Klein starts from her small full-body face) comes back with a pass on the draft that has her main picture's face, cropped close, as the reference (Eve's). A side seat made from her facing one turns her head more than her body; that's enough for the glass After picking the picture, check the look's subject: it's made from her full body's, so rewrite it for the seat's clothes and skin, and keep the word campfire out of it too. Something in her hands (a mug, as in the photo, or Genesis's notebook) gives her hands a place while she talks; the pack's warm-hands clip has her let go with a hand and hold it palms down toward the warmth, so say how in its wording before rendering |
| A new picture for a look she has | replaces a look's picture, for a truer colour or a better likeness |

- **Starts from:** the picture Klein edits. Any of her waist-up looks works, an outfit too (Genesis's
  night looks start from her plain look, without her motes). Its look also gives the new look its
  subject, keep line and ending.
- **Or start from a picture from your computer:** Klein edits that instead; the look above still
  gives the description.
- **More pictures for Klein to use:** a dress, shoes, a purse, a close-up of her face. Her picture
  stays picture 1 (her framing, pose and light); the ones you add are picture 2, 3 and so on, in the
  order chosen. Say which holds what: "she now wears the dress from picture 2 and the sandals from
  picture 3".
- **She wears it on** and **Name** (outfits only): when the glass puts her in it, and a name that
  tells two outfits for the same time apart (`dress` makes `main@eveningdress`).
- **She now wears:** the clothes, as you'd describe them to someone. For a full body this is **what
  she wears below the waist**; see below.
- **Instruction for Klein:** written for you. It keeps what the start look's own Klein line keeps (her
  face, hair, glasses, motes). Looks made from other looks often have no such line, and then it says
  only "her face, expression, hair and pose": add her signature things, and anything her pose holds.
- **Versions:** two to four, about a minute each. Klein waits behind any render on the GPU.

Klein reads only the instruction. "She now wears" is copied into it, and the new look's subject line
is written from it, so the two always name the same clothes:
- A changed instruction still follows "She now wears": what you type there replaces the clothes after
  "wears" (for a full body, its "She wears …" sentence).
- **Make pictures** fills in a "…" still standing where her clothes go.
- **Make pictures** refuses an instruction that names other clothes than "She now wears", so the
  picture and its clips can't disagree.

**A full body keeps the top from the picture it starts from.** For an outfit's full body, "She now
wears" is what's below the waist (*faded ripped jeans and worn tan work boots*). Words about the top
change the top in the new picture and are said twice in the new look's subject line, so leave them
out, or tidy the subject line afterwards.

The versions appear at the top of Looks; click one to see it large, and **Use this one** makes it the
look. **Discard** throws the versions away and puts their settings back in the form (kind, start
look, when and name, what she wears, the instruction, how many), so the next try is one changed line
away. Pictures sent from your computer have to be chosen again; the discarded files stay in
`clean/drafts/`.

| | |
|:---:|:---:|
| ![The new look form for an outfit's full body](docs/images/outfit-full-body.jpg) | ![Klein's three versions](docs/images/outfit-2-versions.jpg) |
| An outfit's own full body: what she wears below the waist | Pick the version that keeps her most herself |

**A new picture for a look she has** starts from that look's own picture, with an instruction for
natural, neutral colour. When you pick a version, every clip in that look is planned again from it
with a new seed; the old takes stay in each clip's history, and its clips come off the glass until
their new takes are kept. Fix the look's subject line too ("clean neutral light", not "soft warm
light") before rendering.

### When she wears what

An outfit's name tells the glass when she wears it (`OUTFIT_RULES` in `living.js`):

| Name | When |
|---|---|
| `night…` | from 10 pm until she wakes; she sleeps in it if it has its own asleep look. `nightwarm…` when it's 70°F or warmer, `nightcold…` below, chosen when she puts them on and kept until morning |
| `cold…` | under 45°F |
| `hot…` | over 85°F |
| `evening…` | 6 to 11 pm |
| `day…` | a different day outfit each day, taking turns with her usual clothes |

The rules are checked in that order. Temperatures come from your own weather station when Home
Assistant has one (see the [reference](../docs/reference.md)).

- **Visits.** She wears an outfit in visits of about 30 seconds per clip it has (3 to 15 minutes),
  then goes back to her usual clothes for at least 25 minutes. Each outfit also has a daily total of
  two minutes per clip. More clips mean longer visits. A night outfit stays on all night.
- **Changes** happen at a quiet moment, with a camera cut or a change-of-clothes clip made for that
  pair of looks. She changes back to her usual clothes to sleep unless her night outfit has its own
  asleep look.
- **Other looks in her usual clothes** (Genesis's `plain`, Optic's `noheart`) take about a third of
  the time she'd otherwise spend in her usual clothes, decided every twenty minutes, and change on
  screen with clips made for them.
- **Clothes she chooses herself** (`glass_wear`) stay on until she goes to sleep or changes again, at
  most until midnight. Day clothes chosen before 10 pm come off then for her night clothes.
- **Windy days:** wind clips play only when it's windy (a 10-minute average of 12 mph or gusts of 20,
  held for 20 minutes after the last such reading), in the look she has on.

### What the Chooms can ask for

The Chooms can ask the glass for things themselves, with four tools in the Choom app (the
looking-glass skill):

| Tool | What it does |
|---|---|
| `glass_move("a little dance")` | plays a move once, in the clothes she has on, at her next quiet moment on the glass within half an hour |
| `glass_wear("my red dress")` | changes her clothes at her next quiet moment; she keeps them on until bedtime, or until she changes again (day clothes chosen by day: until 10 pm) |
| `glass_closet()` | lists her moves and the clothes in her closet, never what she has on; it only lists, and its answer points her to `glass_wear` |
| `glass_wish("a midnight-blue silk slip dress")` | puts clothes or a move she'd like on her wish list; nothing changes on the glass |

The glass answers from what's built:
- **Moves** are her selfie moves, her full-body clips, and clips named for a move: a dance, a wave,
  a kiss, a curtsy. "Spin around" finds a twirl, and "flip my hair" finds a hair flip. A move plays only
  in the clothes she has on: one she has only in an outfit is answered "only in" those clothes, and one
  only in clothes she can't wear yet becomes a wish. Answers name the move as something she does
  ("blow a kiss", "walk the runway").
- **Places** answer to their name and the words of their description: "sit by the fire" finds
  Genesis's campfire once `to_campfire` is built. The glass changes her into her usual clothes if
  need be, cuts to her full body, and she sits down; she stays about ten minutes (`placeMinutes`),
  talking from there if spoken to, then gets up and the glass cuts back. Bedtime, the group stage and
  his turning to another Choom end it sooner. Asked again while she's there, she stays longer.
- **The campfire circle** answers to the fire and a group word: "let's all sit around the fire".
  While the room is talking it sits them all around the glass's campfire for the next hour, if every
  Choom in the room has a seat (Campfire circle); outside a room she goes to her own campfire if she
  has one.
- **Clothes** match an outfit's **closet words**. They're read from what she wears in the look
  ("dress, burgundy, red"), and you can change them on the look's card; empty goes back to the ones
  read from her clothes. A garment, colour or fabric she names must be in the outfit, so "the red
  dress" finds the burgundy one but "a blue silk dress" doesn't find a green one. If two outfits fit
  equally, the glass picks one at random. Night clothes also answer to pajamas, bed and their own
  garments, warm or cold by the weather.
- **Her usual clothes** can be asked for by description as well as by "my usual clothes": "my
  wireframe dress", "my cream blouse". A tie with them goes to them. "Own" beside a garment means that
  garment ("my own green dress" is her green dress).
- **What her closet calls each outfit** (`glass_closet`, and "you change into …") is what she wears in
  it. A look in her usual clothes, changed some other way, is named by what she holds there or not:
  Optic's heart-aside look is "your usual clothes, without a glowing fire agate heart". A pose is not
  clothes, so it stays out.

![An outfit's closet words on its look card](docs/images/closet-words.jpg)

Something she asks for and hasn't got becomes a **wish**, and so does whatever she asks for with
`glass_wish`. Her wishes show at the top of Plan & render, with when and how often she asked. Each
has a button to start making it: **Write it** opens Write your own clip, and **New outfit** opens New
look with her words filled in. **Made it** moves a wish to her list of wishes that came true, folded
away under the open ones (`portraits/<id>/wishes_done.json`, with the day it was made); **Let go**
takes one off the list if it won't be made.

![Her wishes on the Plan page](docs/images/wishes.jpg)

The request goes down the hologram's feed and the hologram's server answers it, the way the glass
camera's requests work, so the hologram's computer opens no port. The matching is in
`tools/closet.py`, and the Studio writes `portraits/<id>/closet.json` when a look's words change and
on every build. To try a request by hand, use the hologram's test hook:
`curl -X POST 127.0.0.1:8765/glass -d '{"choom":"genesis","op":"move","what":"twirl"}'`. To forget
every Choom's chosen clothes, use `curl -X POST 127.0.0.1:8765/control -d '{"glassReset":true}'`.

### A new Choom

![The New Choom dialog](docs/images/new-2-dialog.jpg)

**+ New Choom** starts from a picture of her:
1. Klein cleans the picture up into her main picture on black, unless you untick the clean-up.
2. **Put her on the glass** (On the glass) makes her still relief and adds her to
   `portraits/manifest.json`:
   - her cut-out (`tools/make_masks.py <id> <picture>`)
   - depth and plate (`tools/make_depth.py <id> <picture> <name> <colour> <style>`)
   - her mouth (`tools/make_landmarks.py <id>`)

   "OK <name>" at the tower reaches her. A name Whisper mishears can list other spellings in her
   manifest entry's `wake`.
3. Her clips come from the library like everyone else's, and replace the still relief once built.

The [tutorial](docs/tutorial-new-choom.md) walks through all of it.

## Setup

- The hologram running on a Looking Glass Portrait ([hologram README](../README.md)).
- [Wan2GP](https://github.com/deepbeepmeep/Wan2GP) with MiniMax H3 (`minimax_h3_fl2va_pdd`) for clips
  and Flux.2 Klein 9B (`flux2_klein_9b`) for pictures. Its venv also has rembg (U2-Net) and numpy,
  which the cut-outs and checks use.
- A Python with Depth Anything V2 and MediaPipe for `tools/make_alive.py` (Forge Neo's venv here).
- A GPU with room for H3: about 5½ minutes per five-second clip on an RTX PRO 6000 Blackwell.

Settings go in `~/.config/choom-hologram/studio.json` (or the folder in `$HOLOGRAM_CONFIG`). Any key
you leave out uses the default in `config.py`:

```json
{
  "workspace": "~/choom-studio",
  "wan2gp": "~/pinokio/api/wan2gp/app",
  "forge_python": "~/pinokio/api/forge-neo/app/venv/bin/python",
  "video_model": "minimax_h3_fl2va_pdd",
  "picture_model": "flux2_klein_9b",
  "minutes_per_clip": 5.5,
  "port": 8767,
  "notify": {"url": "http://your-mac.local:3000", "choom": "Aloy", "quiet": ["22:00", "07:00"], "dry_run": false}
}
```

`minutes_per_clip` only sets the time estimates on the page. `notify` sends the morning summary:
- **url:** the Choom app; empty turns it off.
- **choom:** whose Signal thread it comes in, by name or id.
- **quiet:** when it holds messages, from the first time to the second: whole hours (`[22, 7]`) or
  `"HH:MM"` (`["22:00", "07:10"]` lands the summary just after a 7 am briefing).
- **dry_run:** writes the message to `studio/studio.log` instead of sending it.

Settings for testing:
- `portraits` and `tools` point a test Studio at its own portraits folder and stand-in build tools,
  so it never writes or relaunches the real glass.
- `relaunch_retry_s` (default 300) sets how long a reload waits after finding the glass busy.

The API answers only the Studio page and tools on this machine. A POST must send JSON
(`Content-Type: application/json`), and one from another web page (another `Origin`) is refused. To
use it from a terminal:

```
curl -X POST 127.0.0.1:8767/api/jobs/pause -H 'Content-Type: application/json' -d '{}'
```

The workspace holds four folders. Back it up; clips take hours to make.

| Folder | What's in it |
|---|---|
| `clean/` | each look's picture, pictures sent from your computer, and Klein's versions in `drafts/` |
| `clips/` | every rendered clip, with older takes in `takes/` |
| `queue/` | render queues and their logs |
| `studio/` | one project file per Choom, the contact sheets, the work list (`jobs.json`) |

## Command line

Everything on the page also works from a terminal, run from the hologram folder:

```
python3 studio/studio.py status [CHOOM]                # clips per status, looks, what's on the glass
python3 studio/studio.py packs optic main              # the library's actions for a look
python3 studio/studio.py plan optic main quiet         # plan the quiet moments she doesn't have yet
python3 studio/studio.py plan optic main quiet glance  # or only some actions of a pack
python3 studio/studio.py render optic [--queue NAME]   # queue her planned clips and render them
python3 studio/studio.py collect                       # pick up finished renders
python3 studio/studio.py review optic [CLIP ...]       # sheets and checks for new renders
python3 studio/studio.py keep optic optic_idle_glance  # or drop
python3 studio/studio.py place optic optic_idle_glance # or remove
python3 studio/studio.py build optic [--no-relaunch]   # put her sequence on the glass
python3 studio/studio.py import [CHOOM ...]            # adopt clips made before the Studio
```

While the Studio is running, `render` and `build` go into its work list, so they take their turn on the
GPU and show on the page; otherwise they run in the terminal.

`import` (`studio/import_existing.py`) reads the old render queues (`queue/<name>.zip` with
`<name>_plan.json`) for each clip's prompt and seed, and the glass's `alive.json` for what's on the
glass.

## Files

| File | What it does |
|---|---|
| `studio.py` | command line |
| `server.py` | the page's server and API (standard library only) |
| `config.py` | settings and workspace paths |
| `project.py` | a Choom's project file: looks, clips, statuses, sequence, closet |
| `prompts.py` | prompt shape, clip lengths, and the wording checker |
| `packs.json` | the clip library |
| `plan.py` | turns library actions, your own clips and changes of clothes into named, seeded clips |
| `render.py` | Wan2GP queue zips (`templates/h3_task.json`), the headless run, collecting outputs by seed |
| `review.py` | contact sheets and automatic checks (needs numpy) |
| `pictures.py` | Klein edits for new looks (outfits, full body, asleep, new pictures, a new Choom) |
| `build.py` | still reliefs for new Chooms; the build's steps (masks, depth and reliefs), her closet, relaunch, prune |
| `jobs.py` | the work list: GPU, CPU and glass lanes, pause and resume, picking jobs up after a restart |
| `notify.py` | the morning summary on Signal |
| `housekeeping.py` | disk use and what nothing uses any more |
| `import_existing.py` | adopts clips made before the Studio |
| `web/` | the page |
| `docs/` | the tutorials and their screenshots |

## Not yet

- **Looks that change more than clothes, on screen.** Genesis's plain look fades her motes away and
  back, and Optic's no-heart look dissolves her heart; both work. A new look of this kind needs change
  clips named in `tools/clip_roles.py` and an entry in `ALT_LOOKS` in `living.js`. The Studio can
  render the clips but can't yet add the entry.
- **Places in other clothes.** A place is in her usual clothes; asked to go there in an outfit, she
  changes first. `campfire@evening` isn't read as a place yet.
- **The campfire circle as a ring.** The circle is an open arc (everyone faces you across the fire).
  A full ring, with one sitting with her back to you and the circle turning to each new speaker, would
  need a profile and a back view of each Choom.
- **Places by themselves.** She goes to a place only when she asks for it. A place she visits on her
  own now and then (by the fire on evenings) would need hours for it, like an outfit's name gives.
