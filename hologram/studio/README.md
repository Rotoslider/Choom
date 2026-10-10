# Glass Studio

Glass Studio makes and manages the clips that bring a Choom to life on the Looking Glass Portrait.
It plans clips from a library of actions that have worked, renders them with Wan2GP, checks each one
for the usual failures, lets you keep or drop them, and puts the Choom's chosen clips on the glass.

Open it at **http://127.0.0.1:8767** on the machine with the GPU. `launch.sh` starts it with the
hologram; to run it on its own, use `python3 studio/studio.py serve`.

## What you need

- The hologram running on a Looking Glass Portrait (see `../README.md`).
- [Wan2GP](https://github.com/deepbeepmeep/Wan2GP) with MiniMax H3 (`minimax_h3_fl2va_pdd`) for clips and
  Flux.2 Klein 9B for pictures. Its venv also has rembg (U2-Net) and numpy, which the cut-outs and the
  checks use.
- A Python with Depth Anything V2 and MediaPipe for `tools/make_alive.py` (Forge Neo's venv here).
- A GPU with room for H3: about 5½ minutes per five-second clip on an RTX PRO 6000 Blackwell.

Paths go in `~/.config/choom-hologram/studio.json`. Any key you leave out uses the default in
`config.py`:

```json
{
  "workspace": "~/choom-studio",
  "wan2gp": "~/pinokio/api/wan2gp/app",
  "forge_python": "~/pinokio/api/forge-neo/app/venv/bin/python",
  "minutes_per_clip": 5.5,
  "port": 8767
}
```

The workspace holds `clean/` (each look's start picture), `clips/` (every rendered clip),
`queue/` (render queues and their logs) and `studio/` (one project file per Choom, plus the contact
sheets).

## How a Choom is made

A Choom on the glass is a set of short clips, all starting and ending on the same picture of her, so
the page can play them in any order without a seam. Each **look** is one picture: her main pose, a
relaxed pose, full body, asleep, or an outfit (`relaxed@evening`, `main@cold`). A clip's name says
what it's for, using the roles in `tools/clip_roles.py`: `idle_glance` is a quiet moment,
`listen` is for listening, `evening-idle_glance` is the same moment in her evening outfit.

1. **Plan.** In *Plan & render*, choose a look and pick actions from the packs:
   - essentials: a loop she can talk over, listening, thinking
   - quiet moments
   - expressions
   - oops faces
   - sleep
   - selfie moves
   - full body
   - picture looks
   - pose changes

   You can also write your own. Each prompt is built from the look's subject line, the action, the
   camera line and the loop ending. The Studio warns about wording that has gone wrong before:
   - naming an effect you don't want
   - breathing words, which bring fog
   - "leans in", which pushes the camera in
2. **Render.** Choose *Render now* or schedule it for tonight. Each clip lands in Review as soon as
   it's done, while the rest keep rendering. The glass runs slower while the GPU renders.
3. **Review.** Each clip shows a contact sheet (eight frames, first to last) and flags from the
   automatic checks:
   - **background:** the black lifts (fog, a glow, a flash)
   - **push-in:** she grows in the frame (the camera moved)
   - **color:** her colour shifts
   - **seam:** the loop doesn't close
   - **cut:** a new shot starts mid-clip

   The limits were set on the first 784 clips. They catch 38 of the 46 clips dropped by eye and flag
   about 3% of the keepers. About one clip in six fails, so look at every one. Keep it, drop it, or
   re-roll it (the same prompt with a new seed; the old take is kept in `clips/takes/`).
4. **On the glass.** Each look shows its clips on the glass, its kept clips that aren't, and how
   many minutes of quiet moments she has before one repeats. Drag a clip in to add it, drag it out
   to take it off, or drop it onto another clip to swap them. *Build* makes the cut-outs, depth and
   reliefs for new clips (only new ones are encoded), reloads the glass once no Choom is talking, and
   then clears the old videos.
5. **Looks.** Edit each look's subject line, its keep line (said in every clip of the look; Genesis's
   motes stay on her) and its loop ending. **New outfit** makes a new look:
   1. Say what she wears and when: cold days, hot days, evenings, or daytime taking turns with her
      usual clothes. The outfit's name tells the glass when, like `evening…` or `day…`.
   2. Flux.2 Klein makes a few versions from her picture. The instruction keeps everything but her
      clothes, using what her earlier outfit edits kept.
   3. Pick one. It becomes the look (`main@eveningdress`), with her subject line in the new clothes,
      worked out from her other outfits' lines. Then plan its clips: Essentials first (it needs a
      base loop to talk over), then a dozen or more quiet moments.

   On the glass she wears an outfit in short visits, about 30 s per clip it has.

Renders and builds take turns on the GPU; checks run beside them. The list of work survives a
restart. A render keeps going if the Studio closes, and the Studio picks it up again when it starts.

## Command line

Everything on the page also works from a terminal:

```
python3 studio/studio.py status                       # every Choom: clips, looks, what's on the glass
python3 studio/studio.py packs optic main             # the library's actions for a look
python3 studio/studio.py plan optic main quiet        # plan the quiet moments she doesn't have yet
python3 studio/studio.py render optic                 # queue her planned clips and render them
python3 studio/studio.py review optic                 # sheets and checks for new renders
python3 studio/studio.py keep optic optic_idle_glance
python3 studio/studio.py place optic optic_idle_glance
python3 studio/studio.py build optic                  # put her sequence on the glass
```

To adopt clips made before the Studio, run `studio/import_existing.py`. It reads the old render
queues (`queue/<name>.zip` with `<name>_plan.json`) for each clip's prompt and seed, and the glass's
`alive.json` for what's on the glass.

## Files

| File | What it does |
|---|---|
| `studio.py` | command line |
| `server.py` | the page's server and API (standard library only) |
| `project.py` | a Choom's project file: looks, clips, statuses, sequence |
| `prompts.py` | prompt shape and the wording checker |
| `packs.json` | the clip library |
| `plan.py` | turns library actions into named, seeded clips |
| `render.py` | Wan2GP queue zips, the headless run, collecting outputs by seed |
| `review.py` | contact sheets and automatic checks (needs numpy) |
| `build.py` | masks, depth and reliefs, relaunch, prune |
| `pictures.py` | Klein edits for new looks, choosing a version |
| `jobs.py` | the GPU and CPU work lists |
| `web/` | the page |

## A new Choom

*+ New Choom* starts one from a picture of her: a render, a portrait, or her Choom avatar.

1. Give her name (as the Choom app calls her, so the glass knows when she talks), her colour, her
   particles, and a line saying who she is. That line starts every prompt.
2. Flux.2 Klein cleans the picture up into a picture of her on black, facing you. Pick the best one
   under Looks; it becomes her `main` look.
3. *On the glass → Put her on the glass* makes her still relief and adds her to
   `portraits/manifest.json`:
   - her cut-out (`tools/make_masks.py <id> <picture>`)
   - depth and plate (`tools/make_depth.py <id> <picture> <name> <colour> <style>`)
   - her mouth (`tools/make_landmarks.py <id>`)

   The glass reloads with her when it's quiet, and "OK <name>" at the tower reaches her. A wake
   word Whisper mishears can take other spellings in her manifest entry's `wake`.
4. Plan Essentials and quiet moments for her main look, render them, keep the good ones, and build.
   Her clips replace the still picture. Outfits, a full-body picture and sleep come after, the same
   way as for the others.

## Not yet

- Looks that change more than clothes, changed on screen with clips made for it, are wired by hand.
  Genesis's plain look fades her motes away and back, and Optic's no-heart look dissolves her heart;
  both work. A new look of this kind needs an entry in `ALT_LOOKS` in `living.js` and change clips
  named in `tools/clip_roles.py`. The Studio can render the clips but can't yet add the entry.
- A full-body picture or an asleep picture for a new Choom is a Klein edit with its own instruction.
  For now, make it in Wan2GP and add it to her project's looks as `full` or `asleep`.
