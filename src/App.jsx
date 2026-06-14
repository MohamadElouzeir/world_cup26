import { useEffect, useMemo, useState, useCallback } from 'react'
import {
  Moon,
  RefreshCw,
  AlertTriangle,
  CalendarDays,
  Clock,
  Trophy,
  Sparkles,
  WifiOff,
  ChevronRight,
} from 'lucide-react'

/* ------------------------------------------------------------------ *
 * Constants
 * ------------------------------------------------------------------ */

const API_URL = 'https://worldcup26.ir/get/games'

// The cutoff: only show matches that kick off at or before 22:00 (10 PM) KSA.
const CUTOFF_HOUR_KSA = 22

// The API's `local_date` carries the SAME wall-clock value as the Persian
// (Tehran) timestamp, i.e. it is Tehran local time = UTC+03:30.
// KSA (Arabia Standard Time) is UTC+03:00. So KSA = Tehran − 30 minutes.
const TEHRAN_OFFSET_MIN = 3 * 60 + 30 // +3:30
const KSA_OFFSET_MIN = 3 * 60 //         +3:00

// Human-readable labels for the API's `type` codes.
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
 * Time helpers
 * ------------------------------------------------------------------ */

/**
 * Parse the API's Tehran wall-clock string ("MM/DD/YYYY HH:mm") and return a
 * normalized object expressed in KSA (UTC+03:00) time.
 *
 * Strategy: build the true UTC instant by treating the components as Tehran
 * time (subtract the +3:30 offset), then re-read the instant shifted into KSA
 * (+3:00) so we can pull the KSA hour / minute / calendar date safely — this
 * also handles games that roll across midnight after the −30min shift.
 *
 * Returns null if the string can't be parsed (defensive: API is third-party).
 */
function parseToKsa(localDate) {
  if (typeof localDate !== 'string') return null
  const m = localDate.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})$/)
  if (!m) return null

  const month = Number(m[1])
  const day = Number(m[2])
  const year = Number(m[3])
  const hour = Number(m[4])
  const minute = Number(m[5])

  if (
    !Number.isFinite(month) ||
    !Number.isFinite(day) ||
    !Number.isFinite(year) ||
    !Number.isFinite(hour) ||
    !Number.isFinite(minute)
  ) {
    return null
  }

  // True UTC instant: Tehran clock minus Tehran's offset.
  const utcMs = Date.UTC(year, month - 1, day, hour, minute) - TEHRAN_OFFSET_MIN * 60_000

  // Shift the instant into KSA so getUTC* methods read KSA wall-clock values.
  const ksaShifted = new Date(utcMs + KSA_OFFSET_MIN * 60_000)

  const ksaHour = ksaShifted.getUTCHours()
  const ksaMinute = ksaShifted.getUTCMinutes()

  // Stable key for grouping by KSA calendar date (YYYY-MM-DD).
  const y = ksaShifted.getUTCFullYear()
  const mo = String(ksaShifted.getUTCMonth() + 1).padStart(2, '0')
  const d = String(ksaShifted.getUTCDate()).padStart(2, '0')
  const dateKey = `${y}-${mo}-${d}`

  return {
    instantMs: utcMs, // for chronological sorting
    ksaHour,
    ksaMinute,
    dateKey,
    // Pretty 12-hour KSA time, e.g. "8:30 PM".
    time12: formatTime12(ksaHour, ksaMinute),
    // Pretty long date for headers, e.g. "Sun, Jun 14".
    dateLabel: formatDateLabel(ksaShifted),
  }
}

function formatTime12(hour24, minute) {
  const period = hour24 >= 12 ? 'PM' : 'AM'
  let h = hour24 % 12
  if (h === 0) h = 12
  const mm = String(minute).padStart(2, '0')
  return `${h}:${mm} ${period}`
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
]

// Format using the UTC fields of an already-KSA-shifted Date.
function formatDateLabel(ksaShiftedDate) {
  const wd = WEEKDAYS[ksaShiftedDate.getUTCDay()]
  const mo = MONTHS[ksaShiftedDate.getUTCMonth()]
  const d = ksaShiftedDate.getUTCDate()
  return `${wd}, ${mo} ${d}`
}

/* ------------------------------------------------------------------ *
 * Data shaping
 * ------------------------------------------------------------------ */

// Normalize a possibly-quoted/empty string field to a trimmed value or "".
function str(v) {
  if (v === null || v === undefined) return ''
  const s = String(v).trim()
  if (s === '' || s.toLowerCase() === 'null') return ''
  return s
}

// Resolve a team's display name. For knockout games the API uses
// `home_team_label` / `away_team_label` (e.g. "Winner Group A"); once teams
// qualify it switches to `home_team_name_en`. We prefer the real country name
// and gracefully fall back to the structural placeholder, then to "TBD".
function resolveTeam(game, side) {
  const name = str(game[`${side}_team_name_en`])
  if (name) return { name, isPlaceholder: false }

  const label = str(game[`${side}_team_label`])
  if (label) return { name: label, isPlaceholder: true }

  return { name: 'TBD', isPlaceholder: true }
}

// Derive the small stage/group chip text, e.g. "Group C" or "Round of 16".
function stageChip(game) {
  const type = str(game.type).toLowerCase()
  if (type === 'group') {
    const g = str(game.group)
    return g ? `Group ${g.toUpperCase()}` : 'Group Stage'
  }
  return STAGE_LABELS[type] || str(game.group) || 'Knockout'
}

// Match status. The live feed currently only ever reports "notstarted" or
// "finished", so in practice we render Upcoming + Finished. We still detect a
// live state defensively so the card lights up correctly if the feed ever
// starts reporting in-progress matches mid-tournament.
function deriveStatus(game) {
  const finished = str(game.finished).toLowerCase() === 'true'
  const elapsed = str(game.time_elapsed).toLowerCase()

  if (finished || elapsed === 'finished') return 'finished'
  if (elapsed === 'notstarted' || elapsed === '') return 'upcoming'
  // Anything else (a minute count like "57'", "ht", "live", ...) => live.
  return 'live'
}

// Parse a "{"A. Player 12'","B. Player 45'"}" style scorer blob into names.
// The feed is inconsistently escaped (curly + straight quotes), so we strip
// the wrapping braces and split on quote-delimited tokens defensively.
function parseScorers(raw) {
  const s = str(raw)
  if (!s || s === '{}') return []
  const inner = s.replace(/^\{/, '').replace(/\}$/, '')
  // Grab anything between any kind of double-quote (straight or curly).
  const matches = inner.match(/[“"]([^”"]+)[”"]/g)
  if (matches) {
    return matches.map((t) => t.replace(/[“”"]/g, '').trim()).filter(Boolean)
  }
  // Fallback: comma split.
  return inner
    .split(',')
    .map((t) => t.replace(/[“”"]/g, '').trim())
    .filter(Boolean)
}

/**
 * Build the full view model from the raw API payload:
 *  - parse + convert times to KSA
 *  - apply the ≤ 22:00 cutoff filter
 *  - sort chronologically and group by KSA calendar date
 * Returns { dateGroups, keptCount, droppedCount, unparsedCount }.
 */
function buildViewModel(rawGames) {
  const games = Array.isArray(rawGames) ? rawGames : []

  let droppedCount = 0
  let unparsedCount = 0
  const kept = []

  for (const g of games) {
    const ksa = parseToKsa(g.local_date)
    if (!ksa) {
      unparsedCount += 1
      continue
    }
    // The rigid rule: keep only kickoffs at or before 22:00 KSA.
    if (ksa.ksaHour > CUTOFF_HOUR_KSA) {
      droppedCount += 1
      continue
    }

    const home = resolveTeam(g, 'home')
    const away = resolveTeam(g, 'away')
    const status = deriveStatus(g)

    kept.push({
      id: str(g.id) || str(g._id) || `${ksa.instantMs}-${home.name}`,
      ksa,
      stage: stageChip(g),
      home,
      away,
      homeScore: str(g.home_score),
      awayScore: str(g.away_score),
      homeScorers: parseScorers(g.home_scorers),
      awayScorers: parseScorers(g.away_scorers),
      status,
    })
  }

  // Chronological sort by true instant.
  kept.sort((a, b) => a.ksa.instantMs - b.ksa.instantMs)

  // Group by KSA calendar date, preserving chronological order.
  const groupMap = new Map()
  for (const match of kept) {
    const key = match.ksa.dateKey
    if (!groupMap.has(key)) {
      groupMap.set(key, {
        dateKey: key,
        dateLabel: match.ksa.dateLabel,
        matches: [],
      })
    }
    groupMap.get(key).matches.push(match)
  }

  return {
    dateGroups: Array.from(groupMap.values()),
    keptCount: kept.length,
    droppedCount,
    unparsedCount,
  }
}

/* ------------------------------------------------------------------ *
 * Presentational components
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

function TeamRow({ team, score, showScore, emphasizeWinner, isWinner }) {
  return (
    <div className="flex min-w-0 items-center justify-between gap-3 py-1.5">
      <span
        className={[
          'min-w-0 truncate text-sm',
          team.isPlaceholder
            ? 'italic text-slate-400'
            : 'font-semibold text-slate-100',
          emphasizeWinner && isWinner ? 'text-white' : '',
        ].join(' ')}
        title={team.name}
      >
        {team.name}
      </span>
      {showScore ? (
        <span
          className={[
            'shrink-0 tabular-nums text-base font-bold',
            emphasizeWinner && isWinner ? 'text-white' : 'text-slate-200',
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

  // Decide winner only when finished and scores are real numbers.
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
    <article className="rounded-2xl border border-slate-800 bg-slate-900/70 p-3.5 shadow-lg shadow-black/20 transition-colors active:bg-slate-800/70">
      {/* Top line: stage chip + status */}
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="inline-flex items-center gap-1 text-[11px] font-medium uppercase tracking-wide text-slate-400">
          <Trophy className="h-3 w-3 text-slate-500" />
          {match.stage}
        </span>
        <StatusBadge status={match.status} />
      </div>

      {/* Teams stacked for clean vertical reading */}
      <div className="divide-y divide-slate-800/80">
        <TeamRow
          team={match.home}
          score={match.homeScore}
          showScore={showScore}
          emphasizeWinner={isFinished}
          isWinner={homeWins}
        />
        <TeamRow
          team={match.away}
          score={match.awayScore}
          showScore={showScore}
          emphasizeWinner={isFinished}
          isWinner={awayWins}
        />
      </div>

      {/* Bottom line: prominent KSA kickoff time */}
      <div className="mt-2.5 flex items-center justify-between gap-2 border-t border-slate-800 pt-2.5">
        <span className="inline-flex items-center gap-1.5 text-sm font-semibold text-cyan-300">
          <Clock className="h-3.5 w-3.5" />
          {match.ksa.time12}
        </span>
        <span className="rounded-md bg-cyan-500/10 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-cyan-400/90 ring-1 ring-inset ring-cyan-500/20">
          KSA Time
        </span>
      </div>
    </article>
  )
}

function DateSection({ group }) {
  return (
    <section className="mb-6">
      <div className="mb-2.5 flex items-center gap-2 px-0.5">
        <CalendarDays className="h-4 w-4 text-slate-500" />
        <h2 className="text-sm font-bold text-slate-200">{group.dateLabel}</h2>
        <span className="text-xs text-slate-500">
          · {group.matches.length} {group.matches.length === 1 ? 'match' : 'matches'}
        </span>
      </div>
      <div className="space-y-3">
        {group.matches.map((m) => (
          <MatchCard key={m.id} match={m} />
        ))}
      </div>
    </section>
  )
}

/* --------- Full-screen states (loading / error / empty) ---------- */

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
      {Array.from({ length: 5 }).map((_, i) => (
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

function EmptyState() {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-16 text-center">
      <div className="mb-4 rounded-full bg-slate-800 p-4 ring-1 ring-inset ring-slate-700">
        <Moon className="h-7 w-7 text-slate-400" />
      </div>
      <h2 className="mb-1 text-base font-bold text-slate-100">
        No bedtime-friendly matches
      </h2>
      <p className="max-w-xs text-sm text-slate-400">
        Every upcoming kickoff is after 10:00 PM KSA, so they’re all hidden to
        protect your sleep. Check back soon.
      </p>
    </div>
  )
}

/* ------------------------------------------------------------------ *
 * Header (sticky, blurred) + filter badge
 * ------------------------------------------------------------------ */

function Header({ onRefresh, refreshing, lastUpdated }) {
  return (
    <header className="sticky top-0 z-50 border-b border-slate-800/80 bg-slate-950/80 backdrop-blur-lg">
      <div className="mx-auto flex max-w-md items-center justify-between gap-2 px-4 pb-2 pt-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-cyan-400 to-emerald-500 shadow-lg shadow-cyan-500/20">
            <Moon className="h-5 w-5 text-slate-950" />
          </div>
          <div className="min-w-0">
            <h1 className="truncate text-base font-extrabold leading-tight text-white">
              WC 2026 Tracker
            </h1>
            <p className="truncate text-[11px] leading-tight text-slate-400">
              {lastUpdated
                ? `Updated ${lastUpdated}`
                : 'Personal bedtime edition'}
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={onRefresh}
          aria-label="Refresh matches"
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-slate-700 bg-slate-900 text-slate-300 transition active:scale-95 active:bg-slate-800"
        >
          <RefreshCw
            className={`h-5 w-5 ${refreshing ? 'animate-spin text-cyan-400' : ''}`}
          />
        </button>
      </div>

      {/* Always-visible filter status badge (also sticky as part of header) */}
      <div className="mx-auto max-w-md px-4 pb-2.5">
        <div className="flex items-center gap-2 rounded-xl border border-emerald-500/25 bg-emerald-500/10 px-3 py-2">
          <Sparkles className="h-4 w-4 shrink-0 text-emerald-400" />
          <p className="text-xs font-semibold leading-tight text-emerald-200">
            Bedtime-Friendly{' '}
            <span className="font-medium text-emerald-300/80">
              (Kickoffs ≤ 10:00 PM KSA)
            </span>
          </p>
        </div>
      </div>
    </header>
  )
}

/* ------------------------------------------------------------------ *
 * Root App
 * ------------------------------------------------------------------ */

export default function App() {
  const [rawGames, setRawGames] = useState(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState(null)
  const [lastUpdated, setLastUpdated] = useState(null)

  const fetchGames = useCallback(async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true)
    else setLoading(true)
    setError(null)

    try {
      const res = await fetch(API_URL, {
        headers: { Accept: 'application/json' },
        cache: 'no-store',
      })
      if (!res.ok) {
        throw new Error(`Server responded ${res.status}`)
      }
      const data = await res.json()
      const games = Array.isArray(data?.games) ? data.games : []
      setRawGames(games)
      setLastUpdated(
        new Date().toLocaleTimeString([], {
          hour: 'numeric',
          minute: '2-digit',
        }),
      )
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error')
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [])

  // Fetch dynamically on page load.
  useEffect(() => {
    fetchGames(false)
  }, [fetchGames])

  // Derive the view model (memoized; recomputes only when data changes).
  const view = useMemo(
    () => (rawGames ? buildViewModel(rawGames) : null),
    [rawGames],
  )

  let body
  if (loading) {
    body = <LoadingState />
  } else if (error) {
    body = <ErrorState message={error} onRetry={() => fetchGames(true)} />
  } else if (!view || view.dateGroups.length === 0) {
    body = <EmptyState />
  } else {
    body = (
      <div className="px-4 pt-4">
        {/* Tiny summary line so the user trusts the filter is working */}
        <div className="mb-4 flex items-center justify-between gap-2 text-[11px] text-slate-500">
          <span className="inline-flex items-center gap-1">
            <ChevronRight className="h-3 w-3" />
            Showing {view.keptCount}{' '}
            {view.keptCount === 1 ? 'match' : 'matches'}
          </span>
          {view.droppedCount > 0 ? (
            <span className="inline-flex items-center gap-1 text-slate-500">
              <Moon className="h-3 w-3" />
              {view.droppedCount} late{' '}
              {view.droppedCount === 1 ? 'game' : 'games'} hidden
            </span>
          ) : (
            <span className="text-slate-600">No late games today</span>
          )}
        </div>

        {view.dateGroups.map((group) => (
          <DateSection key={group.dateKey} group={group} />
        ))}

        <p className="pb-8 pt-2 text-center text-[11px] leading-relaxed text-slate-600">
          Times shown in Saudi Arabia Standard Time (GMT+3).
          <br />
          Late-night kickoffs after 10 PM are filtered out.
        </p>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <Header
        onRefresh={() => fetchGames(true)}
        refreshing={refreshing}
        lastUpdated={lastUpdated}
      />
      <main className="mx-auto max-w-md pb-[env(safe-area-inset-bottom)]">
        {body}
      </main>
    </div>
  )
}
