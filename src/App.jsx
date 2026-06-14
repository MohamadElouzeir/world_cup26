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

// Only kickoffs at or before this KSA hour count as "bedtime-friendly".
const BEDTIME_CUTOFF_HOUR = 22 // 10:00 PM KSA

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
      isBedtime: hour <= BEDTIME_CUTOFF_HOUR && hour >= 6, // friendly window 6am–10pm
      isLate: hour > BEDTIME_CUTOFF_HOUR || hour < 6, // 11pm–5:59am = late/dawn
      stage: stageChip(g),
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
 * Small UI pieces
 * ------------------------------------------------------------------ */

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
        {hiddenLate > 0 ? 'Nothing before 10 PM' : 'No matches'}
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
              {bedtimeOnly ? 'Before 10 PM' : 'All matches'}
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

  // Apply the stage filter first, so the day strip only offers days that
  // actually have matches for the chosen stage (e.g. pick Knockouts and the
  // day tabs jump straight to the knockout days — no scrolling past groups).
  const stageMatches = useMemo(() => {
    if (stageFilter === 'group') return allMatches.filter((m) => !m.isKnockout)
    if (stageFilter === 'knockout') return allMatches.filter((m) => m.isKnockout)
    return allMatches
  }, [allMatches, stageFilter])

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

  let body
  if (loading) {
    body = <LoadingState />
  } else if (error) {
    body = <ErrorState message={error} onRetry={() => fetchGames(true)} />
  } else if (dayGroups.length === 0) {
    body = (
      <div className="px-6 py-16 text-center text-sm text-slate-400">
        No fixtures available right now.
      </div>
    )
  } else {
    body = (
      <>
        {/* Stage filter + day strip (stacked, sticky under the header) */}
        <div className="sticky top-[118px] z-40 border-b border-slate-800/60 bg-slate-950/80 backdrop-blur-lg">
          <div className="mx-auto max-w-md">
            {/* Stage segmented control */}
            <div className="flex gap-1.5 px-4 pt-2.5">
              {STAGE_TABS.map((t) => (
                <button
                  key={t.value}
                  type="button"
                  onClick={() => setStageFilter(t.value)}
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
            {/* Day chips */}
            <div className="flex gap-2 overflow-x-auto px-4 py-2.5 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
              {dayGroups.map((g) => (
                <DayChip
                  key={g.dateKey}
                  group={g}
                  isActive={g.dateKey === selectedDate}
                  isToday={g.dateKey === todayKey}
                  onClick={() => setSelectedDate(g.dateKey)}
                  refCb={g.dateKey === selectedDate ? activeChipRef : null}
                />
              ))}
            </div>
          </div>
        </div>

        {/* Selected day's matches */}
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

          {visibleMatches.length === 0 ? (
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

          {/* When filtering, hint how many late games are tucked away */}
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
