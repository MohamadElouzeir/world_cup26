import { useEffect, useMemo, useState, useCallback, useRef } from 'react'
import {
  Moon,
  Sun,
  RefreshCw,
  CalendarDays,
  Clock,
  Trophy,
  WifiOff,
  ChevronRight,
  BedDouble,
  Eye,
  EyeOff,
  Sparkles,
} from 'lucide-react'

/* ------------------------------------------------------------------ *
 * Constants
 * ------------------------------------------------------------------ */

const API_URL = 'https://worldcup26.ir/get/games'

// Kickoffs up to and including this KSA hour count as "friendly" (i.e. before
// midnight). 23 = 11 PM, so anything from 00:00 (midnight) onward is "late".
const BEDTIME_CUTOFF_HOUR = 23 // up to 11:xx PM KSA; cutoff at 12 AM

const KSA_TZ = 'Asia/Riyadh' // GMT+3, no DST

// The feed's `local_date` is each HOST STADIUM's own local wall-clock time
// (the 2026 World Cup is hosted across the US / Mexico / Canada, spanning
// several timezones). To get a correct KSA time we must interpret each match
// in its stadium's timezone, then convert. IANA zones handle DST for us
// (June–July = daylight time in North America).
const STADIUM_TZ = {
  1: 'America/Mexico_City', // Estadio Azteca, Mexico City
  2: 'America/Mexico_City', // Estadio Akron, Guadalajara
  3: 'America/Monterrey', //   Estadio BBVA, Monterrey
  4: 'America/Chicago', //     AT&T Stadium, Dallas
  5: 'America/Chicago', //     NRG Stadium, Houston
  6: 'America/Chicago', //     Arrowhead, Kansas City
  7: 'America/New_York', //    Mercedes-Benz, Atlanta
  8: 'America/New_York', //    Hard Rock, Miami
  9: 'America/New_York', //    Gillette, Boston
  10: 'America/New_York', //   Lincoln Financial, Philadelphia
  11: 'America/New_York', //   MetLife, New York/New Jersey
  12: 'America/Toronto', //    BMO Field, Toronto
  13: 'America/Vancouver', //  BC Place, Vancouver
  14: 'America/Los_Angeles', //Lumen Field, Seattle
  15: 'America/Los_Angeles', //Levi's, San Francisco Bay Area
  16: 'America/Los_Angeles', //SoFi, Los Angeles
}
const FALLBACK_TZ = 'America/New_York'

// Top-level stage filter chips.
const STAGE_TABS = [
  { value: 'all', label: 'All' },
  { value: 'group', label: 'Groups' },
  { value: 'knockout', label: 'Knockouts' },
]

// Sub-round chips shown when "Knockouts" is selected. 'all' = every round.
const KO_ROUNDS = [
  { value: 'all', label: 'All' },
  { value: 'r32', label: 'R32' },
  { value: 'r16', label: 'R16' },
  { value: 'qf', label: 'QF' },
  { value: 'sf', label: 'SF' },
  { value: 'final', label: 'Final' },
]

const STAGE_LABELS = {
  group: 'Group Stage',
  r32: 'Round of 32',
  r16: 'Round of 16',
  qf: 'Quarter-final',
  sf: 'Semi-final',
  third: 'Third-place Play-off',
  final: 'Final',
}

/* ------------------------------------------------------------------ *
 * Timezone helpers (Intl-based, DST-correct)
 * ------------------------------------------------------------------ */

// Offset (in minutes) of `timeZone` at the given UTC instant.
function tzOffsetMinutes(date, timeZone) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
  const map = {}
  for (const p of dtf.formatToParts(date)) map[p.type] = p.value
  // Some environments render midnight as "24" — normalize.
  const hour = map.hour === '24' ? '00' : map.hour
  const asUTC = Date.UTC(
    Number(map.year),
    Number(map.month) - 1,
    Number(map.day),
    Number(hour),
    Number(map.minute),
    Number(map.second),
  )
  return (asUTC - date.getTime()) / 60000
}

// Interpret wall-clock components AS LOCAL to `timeZone` and return true UTC.
function zonedWallClockToUtc(y, mo, d, h, mi, timeZone) {
  const guess = new Date(Date.UTC(y, mo - 1, d, h, mi))
  const off1 = tzOffsetMinutes(guess, timeZone)
  let utc = new Date(guess.getTime() - off1 * 60000)
  const off2 = tzOffsetMinutes(utc, timeZone)
  if (off2 !== off1) utc = new Date(guess.getTime() - off2 * 60000)
  return utc
}

// Cached formatters keyed by purpose (cheap reuse across 100+ matches).
const fmtKsaTime = new Intl.DateTimeFormat('en-US', {
  timeZone: KSA_TZ,
  hour: 'numeric',
  minute: '2-digit',
  hour12: true,
})
const fmtKsaHour24 = new Intl.DateTimeFormat('en-US', {
  timeZone: KSA_TZ,
  hour: '2-digit',
  hour12: false,
})
const fmtKsaDateKey = new Intl.DateTimeFormat('en-CA', {
  timeZone: KSA_TZ, // en-CA => YYYY-MM-DD
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
})
const fmtKsaWeekday = new Intl.DateTimeFormat('en-US', {
  timeZone: KSA_TZ,
  weekday: 'short',
})
const fmtKsaDayNum = new Intl.DateTimeFormat('en-US', {
  timeZone: KSA_TZ,
  day: 'numeric',
})
const fmtKsaMonth = new Intl.DateTimeFormat('en-US', {
  timeZone: KSA_TZ,
  month: 'short',
})

function ksaHour24(utcDate) {
  const h = fmtKsaHour24.format(utcDate)
  return parseInt(h, 10) % 24
}

/* ------------------------------------------------------------------ *
 * Field helpers
 * ------------------------------------------------------------------ */

function str(v) {
  if (v === null || v === undefined) return ''
  const s = String(v).trim()
  if (s === '' || s.toLowerCase() === 'null') return ''
  return s
}

function resolveTeam(game, side) {
  const name = str(game[`${side}_team_name_en`])
  if (name) return { name, isPlaceholder: false }
  const label = str(game[`${side}_team_label`])
  if (label) return { name: label, isPlaceholder: true }
  return { name: 'TBD', isPlaceholder: true }
}

function stageChip(game) {
  const type = str(game.type).toLowerCase()
  if (type === 'group') {
    const g = str(game.group)
    return g ? `Group ${g.toUpperCase()}` : 'Group Stage'
  }
  return STAGE_LABELS[type] || str(game.group) || 'Knockout'
}

function deriveStatus(game) {
  const finished = str(game.finished).toLowerCase() === 'true'
  const elapsed = str(game.time_elapsed).toLowerCase()
  if (finished || elapsed === 'finished') return 'finished'
  if (elapsed === 'notstarted' || elapsed === '') return 'upcoming'
  return 'live'
}

/* ------------------------------------------------------------------ *
 * View-model builder
 * ------------------------------------------------------------------ */

function buildMatches(rawGames) {
  const games = Array.isArray(rawGames) ? rawGames : []
  const out = []

  for (const g of games) {
    const ld = str(g.local_date)
    const m = ld.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})$/)
    if (!m) continue

    const tz = STADIUM_TZ[Number(g.stadium_id)] || FALLBACK_TZ
    const utc = zonedWallClockToUtc(
      Number(m[3]),
      Number(m[1]),
      Number(m[2]),
      Number(m[4]),
      Number(m[5]),
      tz,
    )

    const hour = ksaHour24(utc)
    const home = resolveTeam(g, 'home')
    const away = resolveTeam(g, 'away')

    out.push({
      id: str(g.id) || str(g._id) || `${utc.getTime()}-${home.name}`,
      utcMs: utc.getTime(),
      dateKey: fmtKsaDateKey.format(utc), // YYYY-MM-DD in KSA
      weekday: fmtKsaWeekday.format(utc),
      dayNum: fmtKsaDayNum.format(utc),
      monthShort: fmtKsaMonth.format(utc),
      timeLabel: fmtKsaTime.format(utc), // "10:00 PM"
      ksaHour: hour,
      isBedtime: hour <= BEDTIME_CUTOFF_HOUR && hour >= 6, // friendly: 6am–11:xx pm
      isLate: hour > BEDTIME_CUTOFF_HOUR || hour < 6, // 12am–5:59am = late/dawn
      stage: stageChip(g),
      type: str(g.type).toLowerCase(), // group | r32 | r16 | qf | sf | third | final
      isKnockout: str(g.type).toLowerCase() !== 'group',
      home,
      away,
      homeScore: str(g.home_score),
      awayScore: str(g.away_score),
      status: deriveStatus(g),
    })
  }

  out.sort((a, b) => a.utcMs - b.utcMs)
  return out
}

// Group an already-sorted match list into [{dateKey, label, sub, matches}].
function groupByDate(matches) {
  const map = new Map()
  for (const mt of matches) {
    if (!map.has(mt.dateKey)) {
      map.set(mt.dateKey, {
        dateKey: mt.dateKey,
        weekday: mt.weekday,
        dayNum: mt.dayNum,
        monthShort: mt.monthShort,
        matches: [],
      })
    }
    map.get(mt.dateKey).matches.push(mt)
  }
  return Array.from(map.values())
}

// Today's KSA date key, for default selection + "Today" labelling.
function todayKsaKey() {
  return fmtKsaDateKey.format(new Date())
}

/* ------------------------------------------------------------------ *
 * Group standings
 * ------------------------------------------------------------------ */

// Build league tables from the raw games. Only finished group matches with
// numeric scores contribute; teams are seeded so they appear before kickoff.
// Returns [{ group: 'A', rows: [{name, p, w, d, l, gf, ga, gd, pts}] }].
function buildStandings(rawGames) {
  const games = Array.isArray(rawGames) ? rawGames : []
  const groups = new Map() // group -> Map(teamName -> stats)

  const ensure = (grp, name) => {
    if (!groups.has(grp)) groups.set(grp, new Map())
    const tbl = groups.get(grp)
    if (!tbl.has(name)) {
      tbl.set(name, { name, p: 0, w: 0, d: 0, l: 0, gf: 0, ga: 0, gd: 0, pts: 0 })
    }
    return tbl.get(name)
  }

  for (const g of games) {
    if (str(g.type).toLowerCase() !== 'group') continue
    const grp = str(g.group).toUpperCase()
    if (!grp) continue
    const home = str(g.home_team_name_en) || str(g.home_team_label)
    const away = str(g.away_team_name_en) || str(g.away_team_label)
    if (!home || !away) continue

    // Seed both teams so the table is complete even before any match is played.
    const hs = ensure(grp, home)
    const as = ensure(grp, away)

    const finished = str(g.finished).toLowerCase() === 'true'
    const h = Number(g.home_score)
    const a = Number(g.away_score)
    if (!finished || !Number.isFinite(h) || !Number.isFinite(a)) continue

    hs.p += 1; as.p += 1
    hs.gf += h; hs.ga += a
    as.gf += a; as.ga += h
    if (h > a) { hs.w += 1; hs.pts += 3; as.l += 1 }
    else if (h < a) { as.w += 1; as.pts += 3; hs.l += 1 }
    else { hs.d += 1; as.d += 1; hs.pts += 1; as.pts += 1 }
  }

  const result = []
  for (const [group, tbl] of groups) {
    const rows = Array.from(tbl.values())
    for (const r of rows) r.gd = r.gf - r.ga
    rows.sort(
      (x, y) =>
        y.pts - x.pts || y.gd - x.gd || y.gf - x.gf || x.name.localeCompare(y.name),
    )
    result.push({ group, rows })
  }
  result.sort((x, y) => x.group.localeCompare(y.group))
  return result
}

/* ------------------------------------------------------------------ *
 * Small UI pieces
 * ------------------------------------------------------------------ */

// A compact league table for one group. Top 2 rows are tinted green (direct
// qualifiers); 3rd is amber (possible best-third); 4th is muted.
function StandingsTable({ group, rows }) {
  return (
    <section className="overflow-hidden rounded-xl border border-slate-800 bg-slate-900/70">
      <div className="flex items-center gap-1.5 border-b border-slate-800 px-2 py-1.5">
        <span className="flex h-5 w-5 items-center justify-center rounded bg-gradient-to-br from-cyan-400 to-emerald-500 text-[11px] font-extrabold text-slate-950">
          {group}
        </span>
        <span className="text-xs font-bold text-slate-200">Group {group}</span>
      </div>

      {/* Column header — compact for the 2-up grid: just GD and Pts */}
      <div className="flex items-center gap-1 px-2 py-1 text-[9px] font-bold uppercase tracking-wide text-slate-500">
        <span className="min-w-0 flex-1 pl-3">Team</span>
        <span className="w-6 shrink-0 text-center">GD</span>
        <span className="w-5 shrink-0 text-center text-slate-300">Pt</span>
      </div>

      <div className="divide-y divide-slate-800/70">
        {rows.map((r, i) => {
          const pos = i + 1
          const accent =
            pos <= 2
              ? 'border-emerald-400'
              : pos === 3
                ? 'border-amber-400/70'
                : 'border-transparent'
          const placeholder =
            r.name.toLowerCase().includes('group') || r.name === 'TBD'
          return (
            <div
              key={r.name}
              className={`flex items-center gap-1 border-l-2 py-1.5 pl-1.5 pr-2 ${accent}`}
            >
              <span
                className={[
                  'w-3 shrink-0 text-center text-[10px] font-bold',
                  pos <= 2 ? 'text-emerald-300' : pos === 3 ? 'text-amber-300' : 'text-slate-500',
                ].join(' ')}
              >
                {pos}
              </span>
              <span
                className={[
                  'min-w-0 flex-1 truncate text-xs',
                  placeholder ? 'italic text-slate-400' : 'font-semibold text-slate-100',
                ].join(' ')}
                title={r.name}
              >
                {r.name}
              </span>
              <span className="w-6 shrink-0 text-center text-[11px] tabular-nums text-slate-300">
                {r.gd > 0 ? `+${r.gd}` : r.gd}
              </span>
              <span className="w-5 shrink-0 text-center text-xs font-extrabold tabular-nums text-white">
                {r.pts}
              </span>
            </div>
          )
        })}
      </div>
    </section>
  )
}

function StatusBadge({ status }) {
  if (status === 'live') {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-rose-500/15 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-rose-300 ring-1 ring-inset ring-rose-500/40">
        <span className="h-1.5 w-1.5 animate-pulse-live rounded-full bg-rose-400" />
        Live
      </span>
    )
  }
  if (status === 'finished') {
    return (
      <span className="rounded-full bg-slate-700/60 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-slate-300 ring-1 ring-inset ring-slate-600/60">
        Full-time
      </span>
    )
  }
  return (
    <span className="rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-emerald-300 ring-1 ring-inset ring-emerald-500/30">
      Upcoming
    </span>
  )
}

function TeamRow({ team, score, showScore, isWinner }) {
  return (
    <div className="flex min-w-0 items-center justify-between gap-3 py-1.5">
      <span
        className={[
          'min-w-0 truncate text-sm',
          team.isPlaceholder
            ? 'italic text-slate-400'
            : 'font-semibold text-slate-100',
          isWinner ? 'text-white' : '',
        ].join(' ')}
        title={team.name}
      >
        {team.name}
      </span>
      {showScore ? (
        <span
          className={[
            'shrink-0 tabular-nums text-base font-bold',
            isWinner ? 'text-white' : 'text-slate-300',
          ].join(' ')}
        >
          {score === '' ? '–' : score}
        </span>
      ) : null}
    </div>
  )
}

function MatchCard({ match }) {
  const isFinished = match.status === 'finished'
  const showScore = isFinished || match.status === 'live'

  let homeWins = false
  let awayWins = false
  if (isFinished) {
    const h = Number(match.homeScore)
    const a = Number(match.awayScore)
    if (Number.isFinite(h) && Number.isFinite(a)) {
      homeWins = h > a
      awayWins = a > h
    }
  }

  return (
    <article
      className={[
        'rounded-2xl border p-3.5 shadow-lg shadow-black/20 transition-colors active:bg-slate-800/70',
        match.isLate
          ? 'border-slate-800/70 bg-slate-900/40'
          : 'border-slate-700/80 bg-slate-900/80',
      ].join(' ')}
    >
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="inline-flex items-center gap-1 text-[11px] font-medium uppercase tracking-wide text-slate-400">
          <Trophy className="h-3 w-3 text-slate-500" />
          {match.stage}
        </span>
        <StatusBadge status={match.status} />
      </div>

      <div className="divide-y divide-slate-800/80">
        <TeamRow
          team={match.home}
          score={match.homeScore}
          showScore={showScore}
          isWinner={homeWins}
        />
        <TeamRow
          team={match.away}
          score={match.awayScore}
          showScore={showScore}
          isWinner={awayWins}
        />
      </div>

      <div className="mt-2.5 flex items-center justify-between gap-2 border-t border-slate-800 pt-2.5">
        <span
          className={[
            'inline-flex items-center gap-1.5 text-sm font-semibold',
            match.isLate ? 'text-slate-400' : 'text-cyan-300',
          ].join(' ')}
        >
          <Clock className="h-3.5 w-3.5" />
          {match.timeLabel}
          <span className="text-[10px] font-bold uppercase tracking-wider text-slate-500">
            KSA
          </span>
        </span>

        {match.isLate ? (
          <span className="inline-flex items-center gap-1 rounded-md bg-indigo-500/10 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-indigo-300 ring-1 ring-inset ring-indigo-500/25">
            <Moon className="h-3 w-3" />
            Late
          </span>
        ) : (
          <span className="inline-flex items-center gap-1 rounded-md bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-emerald-300 ring-1 ring-inset ring-emerald-500/25">
            <BedDouble className="h-3 w-3" />
            OK
          </span>
        )}
      </div>
    </article>
  )
}

/* ---- Day selector (horizontal, sticky, scrollable chips) ---- */

function DayChip({ group, isActive, isToday, onClick, refCb }) {
  const friendly = group.matches.some((m) => m.isBedtime)
  return (
    <button
      ref={refCb}
      type="button"
      onClick={onClick}
      className={[
        'flex min-h-[56px] min-w-[58px] shrink-0 flex-col items-center justify-center rounded-xl border px-2.5 py-1.5 transition active:scale-95',
        isActive
          ? 'border-cyan-400/60 bg-cyan-500/15 text-cyan-200'
          : 'border-slate-800 bg-slate-900/60 text-slate-400',
      ].join(' ')}
    >
      <span className="text-[10px] font-semibold uppercase tracking-wide">
        {isToday ? 'Today' : group.weekday}
      </span>
      <span
        className={[
          'text-base font-bold leading-tight',
          isActive ? 'text-white' : 'text-slate-200',
        ].join(' ')}
      >
        {group.dayNum}
      </span>
      <span className="flex items-center gap-0.5 text-[9px] text-slate-500">
        {group.monthShort}
        {friendly && (
          <span className="h-1 w-1 rounded-full bg-emerald-400" />
        )}
      </span>
    </button>
  )
}

/* ---- Loading / error / empty ---- */

function SkeletonCard() {
  return (
    <div className="animate-pulse rounded-2xl border border-slate-800 bg-slate-900/70 p-3.5">
      <div className="mb-3 flex justify-between">
        <div className="h-3 w-20 rounded bg-slate-800" />
        <div className="h-3 w-14 rounded bg-slate-800" />
      </div>
      <div className="space-y-3">
        <div className="h-4 w-2/3 rounded bg-slate-800" />
        <div className="h-4 w-1/2 rounded bg-slate-800" />
      </div>
      <div className="mt-3 h-3 w-24 rounded bg-slate-800" />
    </div>
  )
}

function LoadingState() {
  return (
    <div className="space-y-3 px-4 pt-4">
      <div className="mb-1 flex items-center gap-2 text-sm text-slate-400">
        <RefreshCw className="h-4 w-4 animate-spin text-cyan-400" />
        Loading fixtures…
      </div>
      {Array.from({ length: 4 }).map((_, i) => (
        <SkeletonCard key={i} />
      ))}
    </div>
  )
}

function ErrorState({ message, onRetry }) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-16 text-center">
      <div className="mb-4 rounded-full bg-rose-500/10 p-4 ring-1 ring-inset ring-rose-500/30">
        <WifiOff className="h-7 w-7 text-rose-400" />
      </div>
      <h2 className="mb-1 text-base font-bold text-slate-100">
        Couldn’t load matches
      </h2>
      <p className="mb-5 max-w-xs text-sm text-slate-400">
        {message || 'The live data feed is unreachable right now.'}
      </p>
      <button
        type="button"
        onClick={onRetry}
        className="inline-flex min-h-[44px] items-center gap-2 rounded-xl bg-cyan-500 px-5 py-2.5 text-sm font-bold text-slate-950 shadow-lg shadow-cyan-500/20 transition active:scale-95"
      >
        <RefreshCw className="h-4 w-4" />
        Try again
      </button>
    </div>
  )
}

function EmptyDayState({ hiddenLate, onShowLate }) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-14 text-center">
      <div className="mb-4 rounded-full bg-slate-800 p-4 ring-1 ring-inset ring-slate-700">
        <BedDouble className="h-7 w-7 text-emerald-300" />
      </div>
      <h2 className="mb-5 text-base font-bold text-slate-100">
        {hiddenLate > 0 ? 'Nothing before 12 AM' : 'No matches'}
      </h2>
      {hiddenLate > 0 && (
        <button
          type="button"
          onClick={onShowLate}
          className="inline-flex min-h-[44px] items-center gap-2 rounded-xl border border-slate-700 bg-slate-900 px-4 py-2.5 text-sm font-semibold text-slate-200 transition active:scale-95"
        >
          <Eye className="h-4 w-4" />
          Show late ({hiddenLate})
        </button>
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ *
 * Header
 * ------------------------------------------------------------------ */

function Header({ onRefresh, refreshing, lastUpdated, bedtimeOnly, onToggleBedtime }) {
  return (
    <header className="sticky top-0 z-50 border-b border-slate-800/80 bg-slate-950/85 backdrop-blur-lg">
      <div className="mx-auto flex max-w-md items-center justify-between gap-2 px-4 pb-2.5 pt-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-cyan-400 to-emerald-500 shadow-lg shadow-cyan-500/20">
            <Moon className="h-5 w-5 text-slate-950" />
          </div>
          <div className="min-w-0">
            <h1 className="truncate text-base font-extrabold leading-tight text-white">
              WC 2026 Tracker
            </h1>
            <p className="truncate text-[11px] leading-tight text-slate-400">
              {lastUpdated ? `Updated ${lastUpdated} · KSA` : 'KSA time'}
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={onRefresh}
          aria-label="Refresh"
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-slate-700 bg-slate-900 text-slate-300 transition active:scale-95 active:bg-slate-800"
        >
          <RefreshCw
            className={`h-5 w-5 ${refreshing ? 'animate-spin text-cyan-400' : ''}`}
          />
        </button>
      </div>

      {/* Bedtime filter toggle — the comfort control */}
      <div className="mx-auto max-w-md px-4 pb-2.5">
        <button
          type="button"
          onClick={onToggleBedtime}
          className={[
            'flex w-full items-center justify-between gap-2 rounded-xl border px-3 py-2.5 text-left transition active:scale-[0.99]',
            bedtimeOnly
              ? 'border-emerald-500/30 bg-emerald-500/10'
              : 'border-slate-700 bg-slate-900/70',
          ].join(' ')}
        >
          <span className="flex min-w-0 items-center gap-2">
            {bedtimeOnly ? (
              <BedDouble className="h-4 w-4 shrink-0 text-emerald-400" />
            ) : (
              <Sparkles className="h-4 w-4 shrink-0 text-cyan-400" />
            )}
            <span
              className={[
                'truncate text-sm font-bold',
                bedtimeOnly ? 'text-emerald-200' : 'text-slate-200',
              ].join(' ')}
            >
              {bedtimeOnly ? 'Before 12 AM' : 'All matches'}
            </span>
          </span>
          {/* Toggle pill */}
          <span
            className={[
              'relative h-6 w-11 shrink-0 rounded-full transition-colors',
              bedtimeOnly ? 'bg-emerald-500' : 'bg-slate-700',
            ].join(' ')}
          >
            <span
              className={[
                'absolute top-0.5 h-5 w-5 rounded-full bg-white transition-all',
                bedtimeOnly ? 'left-[22px]' : 'left-0.5',
              ].join(' ')}
            />
          </span>
        </button>
      </div>
    </header>
  )
}

/* ------------------------------------------------------------------ *
 * Root
 * ------------------------------------------------------------------ */

export default function App() {
  const [rawGames, setRawGames] = useState(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState(null)
  const [lastUpdated, setLastUpdated] = useState(null)

  const [bedtimeOnly, setBedtimeOnly] = useState(true)
  const [stageFilter, setStageFilter] = useState('all') // 'all' | 'group' | 'knockout'
  const [koRound, setKoRound] = useState('all') // r32 | r16 | qf | sf | final | all
  const [selectedDate, setSelectedDate] = useState(null) // dateKey
  const activeChipRef = useRef(null)

  const fetchGames = useCallback(async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true)
    else setLoading(true)
    setError(null)
    try {
      const res = await fetch(API_URL, {
        headers: { Accept: 'application/json' },
        cache: 'no-store',
      })
      if (!res.ok) throw new Error(`Server responded ${res.status}`)
      const data = await res.json()
      setRawGames(Array.isArray(data?.games) ? data.games : [])
      setLastUpdated(
        new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }),
      )
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error')
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [])

  useEffect(() => {
    fetchGames(false)
  }, [fetchGames])

  // All matches (correct KSA), sorted.
  const allMatches = useMemo(
    () => (rawGames ? buildMatches(rawGames) : []),
    [rawGames],
  )

  // Group standings, recomputed when data changes.
  const standings = useMemo(
    () => (rawGames ? buildStandings(rawGames) : []),
    [rawGames],
  )

  // Apply the stage filter first, so the day strip only offers days that
  // actually have matches for the chosen stage (e.g. pick Knockouts and the
  // day tabs jump straight to the knockout days — no scrolling past groups).
  // When a specific knockout round is selected, narrow to just that round.
  const stageMatches = useMemo(() => {
    if (stageFilter === 'group') return allMatches.filter((m) => !m.isKnockout)
    if (stageFilter === 'knockout') {
      let ko = allMatches.filter((m) => m.isKnockout)
      if (koRound !== 'all') {
        // "Final" chip also surfaces the third-place play-off alongside it.
        ko = ko.filter((m) =>
          koRound === 'final' ? m.type === 'final' || m.type === 'third' : m.type === koRound,
        )
      }
      return ko
    }
    return allMatches
  }, [allMatches, stageFilter, koRound])

  // Day groups follow the stage filter (but not the bedtime toggle, so the
  // strip stays stable when you just hide late games).
  const dayGroups = useMemo(() => groupByDate(stageMatches), [stageMatches])

  // Pick a sensible selected day. Runs on first load AND whenever the stage
  // filter changes the available days (if the current pick is no longer valid):
  // prefer today, else the next upcoming day, else the first available.
  useEffect(() => {
    if (dayGroups.length === 0) return
    const stillValid = dayGroups.some((g) => g.dateKey === selectedDate)
    if (stillValid) return
    const todayKey = todayKsaKey()
    const exact = dayGroups.find((g) => g.dateKey === todayKey)
    const upcoming = dayGroups.find((g) => g.dateKey >= todayKey)
    setSelectedDate((exact || upcoming || dayGroups[0]).dateKey)
  }, [dayGroups, selectedDate])

  // Keep the selected day chip scrolled into view.
  useEffect(() => {
    if (activeChipRef.current) {
      activeChipRef.current.scrollIntoView({
        behavior: 'smooth',
        inline: 'center',
        block: 'nearest',
      })
    }
  }, [selectedDate])

  const todayKey = todayKsaKey()
  const selectedGroup = dayGroups.find((g) => g.dateKey === selectedDate)

  // Matches to show for the selected day, after the bedtime filter.
  const dayMatches = selectedGroup ? selectedGroup.matches : []
  const visibleMatches = bedtimeOnly
    ? dayMatches.filter((m) => m.isBedtime)
    : dayMatches
  const hiddenLateCount = dayMatches.filter((m) => m.isLate).length

  /* ---- render ---- */

  const isGroupsMode = stageFilter === 'group'
  const isKnockoutMode = stageFilter === 'knockout'

  let body
  if (loading) {
    body = <LoadingState />
  } else if (error) {
    body = <ErrorState message={error} onRetry={() => fetchGames(true)} />
  } else {
    body = (
      <>
        {/* Sticky controls: stage chips, plus KO rounds or day strip */}
        <div className="sticky top-[118px] z-40 border-b border-slate-800/60 bg-slate-950/80 backdrop-blur-lg">
          <div className="mx-auto max-w-md">
            {/* Stage segmented control */}
            <div className="flex gap-1.5 px-4 pt-2.5">
              {STAGE_TABS.map((t) => (
                <button
                  key={t.value}
                  type="button"
                  onClick={() => {
                    setStageFilter(t.value)
                    if (t.value !== 'knockout') setKoRound('all')
                  }}
                  className={[
                    'min-h-[36px] flex-1 rounded-lg px-2 text-xs font-bold transition active:scale-95',
                    stageFilter === t.value
                      ? 'bg-cyan-500 text-slate-950'
                      : 'bg-slate-900/70 text-slate-400 ring-1 ring-inset ring-slate-800',
                  ].join(' ')}
                >
                  {t.label}
                </button>
              ))}
            </div>

            {/* Knockout round chips (only in Knockouts mode) */}
            {isKnockoutMode && (
              <div className="flex gap-1.5 overflow-x-auto px-4 pt-2 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
                {KO_ROUNDS.map((r) => (
                  <button
                    key={r.value}
                    type="button"
                    onClick={() => setKoRound(r.value)}
                    className={[
                      'min-h-[32px] shrink-0 rounded-lg px-3 text-[11px] font-bold transition active:scale-95',
                      koRound === r.value
                        ? 'bg-indigo-500 text-white'
                        : 'bg-slate-900/70 text-slate-400 ring-1 ring-inset ring-slate-800',
                    ].join(' ')}
                  >
                    {r.label}
                  </button>
                ))}
              </div>
            )}

            {/* Day chips (hidden in Groups mode, which shows tables instead) */}
            {!isGroupsMode && (
              <div className="flex gap-2 overflow-x-auto px-4 py-2.5 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
                {dayGroups.length === 0 ? (
                  <span className="py-2 text-xs text-slate-500">No matches in this round.</span>
                ) : (
                  dayGroups.map((g) => (
                    <DayChip
                      key={g.dateKey}
                      group={g}
                      isActive={g.dateKey === selectedDate}
                      isToday={g.dateKey === todayKey}
                      onClick={() => setSelectedDate(g.dateKey)}
                      refCb={g.dateKey === selectedDate ? activeChipRef : null}
                    />
                  ))
                )}
              </div>
            )}
            {isGroupsMode && <div className="pb-2.5" />}
          </div>
        </div>

        {/* Body: standings tables (Groups) or match list (All / Knockouts) */}
        {isGroupsMode ? (
          <div className="mx-auto max-w-md px-4 pt-4">
            {standings.length === 0 ? (
              <div className="py-16 text-center text-sm text-slate-400">
                No group data available.
              </div>
            ) : (
              <div className="grid grid-cols-2 gap-2.5">
                {standings.map((s) => (
                  <StandingsTable key={s.group} group={s.group} rows={s.rows} />
                ))}
              </div>
            )}
            <p className="pb-8 pt-5 text-center text-[11px] text-slate-600">
              Top 2 of each group advance · plus best 3rd-placed teams
            </p>
          </div>
        ) : (
          <div className="mx-auto max-w-md px-4 pt-4">
            {selectedGroup && (
              <div className="mb-3 flex items-center justify-between gap-2 px-0.5">
                <div className="flex items-center gap-2">
                  <CalendarDays className="h-4 w-4 text-slate-500" />
                  <h2 className="text-sm font-bold text-slate-200">
                    {selectedGroup.dateKey === todayKey
                      ? 'Today'
                      : `${selectedGroup.weekday}, ${selectedGroup.monthShort} ${selectedGroup.dayNum}`}
                  </h2>
                </div>
                <span className="text-[11px] text-slate-500">
                  {visibleMatches.length}/{dayMatches.length} shown
                </span>
              </div>
            )}

            {dayGroups.length === 0 ? (
              <div className="py-16 text-center text-sm text-slate-400">
                No matches in this round.
              </div>
            ) : visibleMatches.length === 0 ? (
              <EmptyDayState
                hiddenLate={hiddenLateCount}
                onShowLate={() => setBedtimeOnly(false)}
              />
            ) : (
              <div className="space-y-3">
                {visibleMatches.map((m) => (
                  <MatchCard key={m.id} match={m} />
                ))}
              </div>
            )}

            {bedtimeOnly && hiddenLateCount > 0 && visibleMatches.length > 0 && (
              <button
                type="button"
                onClick={() => setBedtimeOnly(false)}
                className="mt-4 flex w-full items-center justify-center gap-2 rounded-xl border border-slate-800 bg-slate-900/60 px-4 py-3 text-xs font-semibold text-slate-400 transition active:scale-[0.99]"
              >
                <EyeOff className="h-3.5 w-3.5" />
                +{hiddenLateCount} late
              </button>
            )}

            <p className="pb-8 pt-5 text-center text-[11px] text-slate-600">
              Times in KSA (GMT+3)
            </p>
          </div>
        )}
      </>
    )
  }

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <Header
        onRefresh={() => fetchGames(true)}
        refreshing={refreshing}
        lastUpdated={lastUpdated}
        bedtimeOnly={bedtimeOnly}
        onToggleBedtime={() => setBedtimeOnly((v) => !v)}
      />
      <main className="pb-[env(safe-area-inset-bottom)]">{body}</main>
    </div>
  )
}
