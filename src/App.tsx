import { useCallback, useEffect, useRef, useState } from 'react'
import './App.css'
import {
  generateRandomString,
  sha256,
  base64UrlEncode,
  formatAddedAt,
  shuffle,
} from './utils'

// --- Data types (match Spotify API responses) ---
type Playlist = {
  id: string
  name: string
}

type Track = {
  id: string
  uri: string | null
  name: string
  artists: string[]
  albumImage: string | null
  previewUrl: string | null
  addedAt: string
  addedBy: string
  addedById: string | null
  addedByImageUrl: string | null
}

type UserProfile = {
  displayName: string
  imageUrl: string | null
}

/** Web Playback SDK: start at 45s, play for 60s */
const SDK_CLIP_START_MS = 45_000
const SDK_CLIP_DURATION_MS = 60_000
/** Preview fallback: start at 0, play 30s */
const PREVIEW_CLIP_DURATION_MS = 30_000

declare global {
  interface Window {
    Spotify?: any
    onSpotifyWebPlaybackSDKReady?: () => void
  }
}

const clientId = import.meta.env.VITE_SPOTIFY_CLIENT_ID as string | undefined
const redirectUri = import.meta.env.VITE_SPOTIFY_REDIRECT_URI as string | undefined

const PKCE_VERIFIER_KEY = 'spotify_pkce_verifier'
const ACCESS_TOKEN_KEY = 'spotify_access_token'

/** In-between sounds from src/content/sounds (name without extension, resolved URL) */
const IN_BETWEEN_SOUNDS: { name: string; url: string }[] = (() => {
  const glob = import.meta.glob('/src/content/sounds/*', { eager: true, query: '?url', import: 'default' }) as Record<string, string>
  return Object.entries(glob).map(([path, url]) => ({
    name: path.replace(/^.*\//, '').replace(/\.[^.]+$/, ''),
    url,
  }))
})()

function App() {
  // Auth & Spotify SDK
  const [accessToken, setAccessToken] = useState<string | null>(null)
  const [deviceId, setDeviceId] = useState<string | null>(null)
  const [playerReady, setPlayerReady] = useState(false)
  // Playlists & tracks
  const [playlists, setPlaylists] = useState<Playlist[]>([])
  const [playlistsLoading, setPlaylistsLoading] = useState(false)
  const [selectedPlaylistId, setSelectedPlaylistId] = useState<string | null>(null)
  const [tracks, setTracks] = useState<Track[]>([])
  const [tracksLoading, setTracksLoading] = useState(false)
  const [userProfiles, setUserProfiles] = useState<Record<string, UserProfile>>({})
  // Playback state: which track, play/pause, clip progress (for progress bar and resume)
  const [currentIndex, setCurrentIndex] = useState<number | null>(null)
  const [isPlaying, setIsPlaying] = useState(false)
  const [clipElapsedMs, setClipElapsedMs] = useState(0)
  const [clipDurationMs, setClipDurationMs] = useState(SDK_CLIP_DURATION_MS)
  const [songsPlayed, setSongsPlayed] = useState(0)
  const [pageElapsedSeconds, setPageElapsedSeconds] = useState(0)
  const [selectedInBetweenSoundUrl, setSelectedInBetweenSoundUrl] = useState<string | null>(null)
  // Refs: timers and DOM/player refs; refs used in callbacks to avoid stale closures
  const clipTimerRef = useRef<number | null>(null)
  const hasExchangedCodeRef = useRef(false)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const inBetweenAudioRef = useRef<HTMLAudioElement | null>(null)
  const playerRef = useRef<any | null>(null)
  const useSdkRef = useRef(false)
  const hasAdvancedRef = useRef(false)
  const selectedInBetweenSoundRef = useRef<string | null>(null)

  // Keep ref in sync so advance logic (in intervals) always sees current selection
  selectedInBetweenSoundRef.current = selectedInBetweenSoundUrl

  // On first load, try to restore token or exchange authorization code (PKCE)
  useEffect(() => {
    const stored = window.sessionStorage.getItem(ACCESS_TOKEN_KEY)
    if (stored) {
      setAccessToken(stored)
      return
    }

    const url = new URL(window.location.href)
    const code = url.searchParams.get('code')
    const error = url.searchParams.get('error')

    if (error) {
      console.error('Spotify auth error', error)
      // Clean query params
      window.history.replaceState({}, document.title, url.pathname)
      return
    }

    if (!code || !clientId || !redirectUri) return

    // In React 18 StrictMode, effects run twice in dev.
    // Prevent double-processing the same authorization code.
    if (hasExchangedCodeRef.current) {
      console.log('[Spotify PKCE] Skipping code exchange (already processed)')
      return
    }
    hasExchangedCodeRef.current = true

    console.log('[Spotify PKCE] Received auth code callback', {
      code,
      redirectUri,
      clientId: clientId.slice(0, 6) + '…',
    })

    const verifier = window.localStorage.getItem(PKCE_VERIFIER_KEY)
    if (!verifier) {
      console.error('[Spotify PKCE] Missing code_verifier in localStorage')
      return
    }

    console.log('[Spotify PKCE] Exchanging code for token', {
      verifierSnippet: verifier.slice(0, 10) + '…',
    })

    const body = new URLSearchParams()
    body.set('grant_type', 'authorization_code')
    body.set('code', code)
    body.set('redirect_uri', redirectUri)
    body.set('client_id', clientId)
    body.set('code_verifier', verifier)

    fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: body.toString(),
    })
      .then((res) => res.json())
      .then((data) => {
        if (!data.access_token) {
          console.error('[Spotify PKCE] Failed to obtain access token', data)
          window.localStorage.removeItem(PKCE_VERIFIER_KEY)
          // Clean query params so the user can retry login cleanly
          window.history.replaceState({}, document.title, url.pathname)
          return
        }
        console.log('[Spotify PKCE] Received access token payload', {
          hasAccessToken: !!data.access_token,
          tokenType: data.token_type,
          scope: data.scope,
          expiresIn: data.expires_in,
        })
        window.sessionStorage.setItem(ACCESS_TOKEN_KEY, data.access_token)
        setAccessToken(data.access_token)
        window.localStorage.removeItem(PKCE_VERIFIER_KEY)
        // Clean query params
        window.history.replaceState({}, document.title, url.pathname)
      })
      .catch((err) => {
        console.error('Error exchanging authorization code', err)
        window.localStorage.removeItem(PKCE_VERIFIER_KEY)
        window.history.replaceState({}, document.title, url.pathname)
      })
  }, [])

  // Page timer – how long this page has been open
  useEffect(() => {
    const startedAt = Date.now()
    const id = window.setInterval(() => {
      const diff = Math.floor((Date.now() - startedAt) / 1000)
      setPageElapsedSeconds(diff)
    }, 1000)
    return () => window.clearInterval(id)
  }, [])

  // Start PKCE flow: generate code_verifier, compute code_challenge, redirect to Spotify
  const handleLogin = async () => {
    if (!clientId || !redirectUri) {
      alert('Spotify client ID or redirect URI is not configured.')
      return
    }

    const scopes = [
      'streaming',
      'user-read-email',
      'user-read-playback-state',
      'user-modify-playback-state',
      'user-read-currently-playing',
      'playlist-read-private',
      'playlist-read-collaborative',
    ]

    const verifier = generateRandomString(128)
    const challenge = base64UrlEncode(await sha256(verifier))

    window.localStorage.setItem(PKCE_VERIFIER_KEY, verifier)

    const authUrl = new URL('https://accounts.spotify.com/authorize')
    authUrl.searchParams.set('response_type', 'code')
    authUrl.searchParams.set('client_id', clientId)
    authUrl.searchParams.set('redirect_uri', redirectUri)
    authUrl.searchParams.set('scope', scopes.join(' '))
    authUrl.searchParams.set('code_challenge_method', 'S256')
    authUrl.searchParams.set('code_challenge', challenge)

    window.location.href = authUrl.toString()
  }

  // Initialize Web Playback SDK when token is ready (required for full-track playback)
  useEffect(() => {
    if (!accessToken) return

    const waitForSpotify = () =>
      new Promise<void>((resolve) => {
        if (window.Spotify) {
          resolve()
          return
        }
        window.onSpotifyWebPlaybackSDKReady = () => resolve()
      })

    let cancelled = false

    waitForSpotify().then(() => {
      if (cancelled || !accessToken || !window.Spotify) return

      const player = new window.Spotify.Player({
        name: 'Shotify Clip Player',
        getOAuthToken: (cb: (token: string) => void) => cb(accessToken),
        volume: 0.8,
      })

      player.addListener('ready', ({ device_id }: { device_id: string }) => {
        setDeviceId(device_id)
        setPlayerReady(true)
      })

      player.addListener('not_ready', () => {
        setPlayerReady(false)
      })

      player.connect()
      playerRef.current = player
    })

    return () => {
      cancelled = true
      if (playerRef.current) {
        playerRef.current.disconnect()
        playerRef.current = null
      }
    }
  }, [accessToken])

  // When we have a token, load the user’s public playlists for the dropdown
  useEffect(() => {
    if (!accessToken) return
    setPlaylistsLoading(true)
    fetch('https://api.spotify.com/v1/me/playlists?limit=50', {
      method: 'GET',
      headers: { Authorization: `Bearer ${accessToken}` },
    })
      .then(async (res) => {
        const body = await res.json()
        if (!res.ok) {
          console.error('[Spotify playlists] Failed to load', { status: res.status, body })
          return
        }
        const list: Playlist[] = (body.items || [])
          .filter((p: any) => p.public !== false)
          .map((p: any) => ({ id: p.id, name: p.name }))
        setPlaylists(list)
      })
      .catch((err) => console.error('[Spotify playlists] Error', err))
      .finally(() => setPlaylistsLoading(false))
  }, [accessToken])

  // When a playlist is selected, fetch all its tracks (paginated), then shuffle and load “added by” user profiles
  useEffect(() => {
    if (!accessToken || !selectedPlaylistId) return
    setTracksLoading(true)
    setTracks([])
    setCurrentIndex(null)
    setUserProfiles({})

    const all: Track[] = []
    let offset = 0
    const limit = 100

    function fetchPage(): Promise<void> {
      const fields = 'items(added_at,added_by(id,display_name,images),item(id,uri,name,artists,album(images),preview_url))'
      return fetch(
        `https://api.spotify.com/v1/playlists/${selectedPlaylistId}/items?limit=${limit}&offset=${offset}&fields=${encodeURIComponent(fields)}`,
        {
          method: 'GET',
          headers: { Authorization: `Bearer ${accessToken}` },
        }
      )
        .then(async (res): Promise<void> => {
          const body = await res.json()
          if (!res.ok) {
            console.error('[Spotify playlist items] Failed', { status: res.status, body })
            return
          }
          const items = body.items || []
          for (const entry of items) {
            // New API uses item.item; legacy uses item.track
            const t = entry.item ?? entry.track
            if (!t || t.type === 'episode') continue
            const addedBy = entry.added_by
            const addedById = addedBy?.id ?? null
            const addedByDisplayName = addedBy?.display_name ?? addedBy?.id ?? '—'
            const addedByImageUrl = addedBy?.images?.[0]?.url ?? null
            all.push({
              id: t.id,
              uri: t.uri ?? null,
              name: t.name,
              artists: (t.artists || []).map((a: any) => a.name),
              albumImage: t.album?.images?.[0]?.url ?? null,
              previewUrl: t.preview_url ?? null,
              addedAt: entry.added_at || '',
              addedBy: addedByDisplayName,
              addedById,
              addedByImageUrl,
            })
          }
          if (body.next) {
            offset += limit
            return fetchPage()
          }
        })
    }

    fetchPage()
      .then(() => {
        setTracks(shuffle([...all]))
        const userIds = [...new Set(all.map((tr) => tr.addedById).filter(Boolean))] as string[]
        if (userIds.length === 0) return
        Promise.all(
          userIds.map((id) =>
            fetch(`https://api.spotify.com/v1/users/${id}`, {
              method: 'GET',
              headers: { Authorization: `Bearer ${accessToken}` },
            }).then(async (res) => {
              const data = await res.json()
              if (!res.ok) {
                console.warn(`[Spotify user] GET /users/${id} failed`, res.status, data)
                return { error: data?.error || true }
              }
              return data
            })
          )
        )
          .then((responses) => {
            const map: Record<string, UserProfile> = {}
            userIds.forEach((id, i) => {
              const p = responses[i] as Record<string, unknown> | undefined
              if (p && !p.error) {
                const displayName =
                  (p.display_name as string) ??
                  (p.displayName as string) ??
                  (typeof p.id === 'string' ? p.id : id)
                const images = p.images as Array<{ url?: string }> | undefined
                const imageUrl = images?.[0]?.url ?? null
                if (i === 0) {
                  console.log('[Spotify user] Sample profile response keys:', Object.keys(p), { display_name: p.display_name, displayName: p.displayName, displayNameResolved: displayName })
                }
                map[id] = { displayName, imageUrl }
              } else {
                map[id] = { displayName: id, imageUrl: null }
              }
            })
            setUserProfiles(map)
          })
          .catch((err: unknown) => console.error('[Spotify user profiles] Error', err))
      })
      .catch((err: unknown) => console.error('[Spotify playlist items] Error', err))
      .finally(() => setTracksLoading(false))
  }, [accessToken, selectedPlaylistId])

  const currentTrack = currentIndex !== null ? tracks[currentIndex] ?? null : null

  // Clear the interval that drives clip progress and auto-advance
  const clearClipTimer = () => {
    if (clipTimerRef.current) {
      window.clearInterval(clipTimerRef.current)
      clipTimerRef.current = null
    }
  }

  // Start playing a track from the beginning. Uses Web Playback SDK (60s from 45s) or preview (30s).
  const playTrackAtIndex = useCallback(
    async (index: number) => {
      if (!tracks[index] || !accessToken) return
      const track = tracks[index]
      const canUseSdk = playerReady && deviceId && track.uri
      const canUsePreview = !!track.previewUrl
      if (!canUseSdk && !canUsePreview) {
        console.warn('Track has no uri (SDK) or preview_url', track.name)
        return
      }

      if (audioRef.current) {
        audioRef.current.pause()
        audioRef.current.currentTime = 0
        audioRef.current = null
      }
      clearClipTimer()
      setClipElapsedMs(0)
      setCurrentIndex(index)
      setIsPlaying(true)
      setSongsPlayed((prev) => prev + 1)
      hasAdvancedRef.current = false

      if (canUseSdk) {
        useSdkRef.current = true
        setClipDurationMs(SDK_CLIP_DURATION_MS)
        try {
          await fetch(
            `https://api.spotify.com/v1/me/player/play?device_id=${deviceId}`,
            {
              method: 'PUT',
              headers: {
                Authorization: `Bearer ${accessToken}`,
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({
                uris: [track.uri],
                position_ms: SDK_CLIP_START_MS,
              }),
            }
          )
        } catch (err) {
          console.error('Failed to start SDK playback', err)
          setIsPlaying(false)
          return
        }
        const start = performance.now()
        clipTimerRef.current = window.setInterval(() => {
          const elapsed = performance.now() - start
          if (elapsed >= SDK_CLIP_DURATION_MS) {
            if (hasAdvancedRef.current) return
            hasAdvancedRef.current = true
            clearClipTimer()
            setClipElapsedMs(SDK_CLIP_DURATION_MS)
            setIsPlaying(false)
            const nextIndex = (index + 1) % tracks.length
            const inBetweenUrl = selectedInBetweenSoundRef.current
            // Play in-between sound then next track, or go straight to next; pause Spotify first so no overlap
            const doAdvance = () => {
              if (inBetweenUrl) {
                if (inBetweenAudioRef.current) {
                  inBetweenAudioRef.current.pause()
                  inBetweenAudioRef.current = null
                }
                const inBetweenAudio = new Audio(inBetweenUrl)
                inBetweenAudioRef.current = inBetweenAudio
                inBetweenAudio.onended = () => {
                  inBetweenAudioRef.current = null
                  setCurrentIndex(nextIndex)
                  playTrackAtIndex(nextIndex)
                }
                inBetweenAudio.play().catch(() => {
                  inBetweenAudioRef.current = null
                  setCurrentIndex(nextIndex)
                  playTrackAtIndex(nextIndex)
                })
              } else {
                setCurrentIndex(nextIndex)
                setTimeout(() => playTrackAtIndex(nextIndex), 300)
              }
            }
            // Pause Spotify so the in-between (or next track) doesn’t play over the current song
            if (deviceId && accessToken) {
              fetch(
                `https://api.spotify.com/v1/me/player/pause?device_id=${deviceId}`,
                { method: 'PUT', headers: { Authorization: `Bearer ${accessToken}` } }
              ).then(doAdvance).catch(() => doAdvance())
            } else {
              doAdvance()
            }
          } else {
            setClipElapsedMs(elapsed)
          }
        }, 100)
      } else {
        // Preview fallback: 30s clip via HTMLAudio
        useSdkRef.current = false
        setClipDurationMs(PREVIEW_CLIP_DURATION_MS)
        const audio = new Audio(track.previewUrl!)
        audioRef.current = audio
        audio.volume = 0.9
        audio.currentTime = 0

        const start = performance.now()
        const advanceToNext = () => {
          if (hasAdvancedRef.current) return
          hasAdvancedRef.current = true
          clearClipTimer()
          setClipElapsedMs(PREVIEW_CLIP_DURATION_MS)
          setIsPlaying(false)
          if (audioRef.current) {
            audioRef.current.pause()
            audioRef.current.currentTime = 0
            audioRef.current = null
          }
          const nextIndex = (index + 1) % tracks.length
          const inBetweenUrl = selectedInBetweenSoundRef.current
          if (inBetweenUrl) {
            if (inBetweenAudioRef.current) {
              inBetweenAudioRef.current.pause()
              inBetweenAudioRef.current = null
            }
            const inBetweenAudio = new Audio(inBetweenUrl)
            inBetweenAudioRef.current = inBetweenAudio
            inBetweenAudio.onended = () => {
              inBetweenAudioRef.current = null
              setCurrentIndex(nextIndex)
              playTrackAtIndex(nextIndex)
            }
            inBetweenAudio.play().catch(() => {
              inBetweenAudioRef.current = null
              setCurrentIndex(nextIndex)
              playTrackAtIndex(nextIndex)
            })
          } else {
            setCurrentIndex(nextIndex)
            setTimeout(() => playTrackAtIndex(nextIndex), 300)
          }
        }

        audio.onended = advanceToNext

        audio.play().catch((err) => {
          console.error('Failed to play preview', err)
          setIsPlaying(false)
        })

        clipTimerRef.current = window.setInterval(() => {
          const elapsed = performance.now() - start
          if (elapsed >= PREVIEW_CLIP_DURATION_MS) {
            advanceToNext()
          } else {
            setClipElapsedMs(elapsed)
          }
        }, 100)
      }
    },
    [tracks, accessToken, playerReady, deviceId]
  )

  // Pause current playback (SDK or preview) and any in-between sound; keep clipElapsedMs for resume
  const handlePause = useCallback(async () => {
    clearClipTimer()
    if (inBetweenAudioRef.current) {
      inBetweenAudioRef.current.pause()
      inBetweenAudioRef.current.currentTime = 0
      inBetweenAudioRef.current = null
    }
    if (useSdkRef.current && deviceId && accessToken) {
      try {
        await fetch(
          `https://api.spotify.com/v1/me/player/pause?device_id=${deviceId}`,
          {
            method: 'PUT',
            headers: { Authorization: `Bearer ${accessToken}` },
          }
        )
      } catch (e) {
        console.error('Failed to pause', e)
      }
    } else if (audioRef.current) {
      audioRef.current.pause()
    }
    setIsPlaying(false)
  }, [deviceId, accessToken])

  // Resume from current clip position (no reset); used when user hits Play after pausing
  const handleResume = useCallback(async () => {
    if (currentIndex === null || !tracks[currentIndex] || !accessToken) return
    const index = currentIndex
    const track = tracks[index]
    const canUseSdk = playerReady && deviceId && track.uri
    const startElapsed = clipElapsedMs

    clearClipTimer()
    if (inBetweenAudioRef.current) {
      inBetweenAudioRef.current.pause()
      inBetweenAudioRef.current.currentTime = 0
      inBetweenAudioRef.current = null
    }
    setIsPlaying(true)
    hasAdvancedRef.current = false

    const doAdvance = (nextIndex: number) => {
      const inBetweenUrl = selectedInBetweenSoundRef.current
      if (inBetweenUrl) {
        if (inBetweenAudioRef.current) {
          inBetweenAudioRef.current.pause()
          inBetweenAudioRef.current = null
        }
        const inBetweenAudio = new Audio(inBetweenUrl)
        inBetweenAudioRef.current = inBetweenAudio
        inBetweenAudio.onended = () => {
          inBetweenAudioRef.current = null
          setCurrentIndex(nextIndex)
          playTrackAtIndex(nextIndex)
        }
        inBetweenAudio.play().catch(() => {
          inBetweenAudioRef.current = null
          setCurrentIndex(nextIndex)
          playTrackAtIndex(nextIndex)
        })
      } else {
        setCurrentIndex(nextIndex)
        setTimeout(() => playTrackAtIndex(nextIndex), 300)
      }
    }

    if (canUseSdk) {
      useSdkRef.current = true
      setClipDurationMs(SDK_CLIP_DURATION_MS)
      try {
        await fetch(
          `https://api.spotify.com/v1/me/player/play?device_id=${deviceId}`,
          {
            method: 'PUT',
            headers: {
              Authorization: `Bearer ${accessToken}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              uris: [track.uri],
              position_ms: SDK_CLIP_START_MS + startElapsed,
            }),
          }
        )
      } catch (err) {
        console.error('Failed to resume SDK playback', err)
        setIsPlaying(false)
        return
      }
      const start = performance.now()
      clipTimerRef.current = window.setInterval(() => {
        const elapsed = performance.now() - start
        const totalElapsed = startElapsed + elapsed
        if (totalElapsed >= SDK_CLIP_DURATION_MS) {
          if (hasAdvancedRef.current) return
          hasAdvancedRef.current = true
          clearClipTimer()
          setClipElapsedMs(SDK_CLIP_DURATION_MS)
          setIsPlaying(false)
          const nextIndex = (index + 1) % tracks.length
          if (deviceId && accessToken) {
            fetch(
              `https://api.spotify.com/v1/me/player/pause?device_id=${deviceId}`,
              { method: 'PUT', headers: { Authorization: `Bearer ${accessToken}` } }
            ).then(() => doAdvance(nextIndex)).catch(() => doAdvance(nextIndex))
          } else {
            doAdvance(nextIndex)
          }
        } else {
          setClipElapsedMs(totalElapsed)
        }
      }, 100)
    } else {
      useSdkRef.current = false
      setClipDurationMs(PREVIEW_CLIP_DURATION_MS)
      const advanceToNext = () => {
        if (hasAdvancedRef.current) return
        hasAdvancedRef.current = true
        clearClipTimer()
        setClipElapsedMs(PREVIEW_CLIP_DURATION_MS)
        setIsPlaying(false)
        if (audioRef.current) {
          audioRef.current.pause()
          audioRef.current.currentTime = 0
          audioRef.current = null
        }
        const nextIndex = (index + 1) % tracks.length
        doAdvance(nextIndex)
      }
      if (audioRef.current) {
        audioRef.current.currentTime = startElapsed / 1000
        audioRef.current.onended = advanceToNext
        audioRef.current.play().catch((err) => {
          console.error('Failed to resume preview', err)
          setIsPlaying(false)
        })
      } else {
        const audio = new Audio(track.previewUrl!)
        audioRef.current = audio
        audio.volume = 0.9
        audio.currentTime = startElapsed / 1000
        audio.onended = advanceToNext
        audio.play().catch((err) => {
          console.error('Failed to resume preview', err)
          setIsPlaying(false)
        })
      }
      const start = performance.now()
      clipTimerRef.current = window.setInterval(() => {
        const elapsed = performance.now() - start
        const totalElapsed = startElapsed + elapsed
        if (totalElapsed >= PREVIEW_CLIP_DURATION_MS) {
          advanceToNext()
        } else {
          setClipElapsedMs(totalElapsed)
        }
      }, 100)
    }
  }, [
    currentIndex,
    tracks,
    clipElapsedMs,
    accessToken,
    deviceId,
    playerReady,
    playTrackAtIndex,
  ])

  const handleNext = () => {
    if (currentIndex === null || currentIndex + 1 >= tracks.length) return
    playTrackAtIndex(currentIndex + 1)
  }

  const handlePrev = () => {
    if (currentIndex === null || currentIndex === 0) return
    playTrackAtIndex(currentIndex - 1)
  }

  const clipProgress = currentTrack
    ? Math.min(1, clipElapsedMs / clipDurationMs)
    : 0

  const isTrackPlayable = (track: Track) => !!(track.uri || track.previewUrl)

  // Row click: pause if same track and playing; resume if same track and paused; else start that track
  const handleRowPlayPause = (index: number, e?: React.MouseEvent) => {
    e?.stopPropagation()
    if (!isTrackPlayable(tracks[index])) return
    if (currentIndex === index && isPlaying) {
      handlePause()
    } else if (currentIndex === index && !isPlaying) {
      handleResume()
    } else {
      playTrackAtIndex(index)
    }
  }

  return (
    <div className="app-root">
      <header className="app-header">
        <h1>Shotify</h1>
        <div className="stats">
          <div className="stat-item">
            <span className="stat-label">Total songs</span>
            <span className="stat-value">{tracks.length}</span>
          </div>
          <div className="stat-item">
            <span className="stat-label">Time on page</span>
            <span className="stat-value">{pageElapsedSeconds}s</span>
          </div>
          <div className="stat-item">
            <span className="stat-label">Songs played</span>
            <span className="stat-value">{songsPlayed}</span>
          </div>
        </div>
      </header>

      {!accessToken && (
        <div className="panel">
          <p>Connect your Spotify account to pick a playlist and play 30-second previews.</p>
          <button onClick={handleLogin}>Log in with Spotify</button>
        </div>
      )}

      {accessToken && (
        <>
          <div className="panel playlist-picker">
            <label htmlFor="playlist-select" className="playlist-label">
              Playlist
            </label>
            <select
              id="playlist-select"
              className="playlist-select"
              value={selectedPlaylistId ?? ''}
              onChange={(e) => setSelectedPlaylistId(e.target.value || null)}
              disabled={playlistsLoading}
            >
              <option value="">Select a playlist…</option>
              {playlists.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
            {playlistsLoading && <span className="loading-text">Loading playlists…</span>}
            <label htmlFor="in-between-select" className="playlist-label">
              Between songs
            </label>
            <select
              id="in-between-select"
              className="playlist-select"
              value={selectedInBetweenSoundUrl ?? ''}
              onChange={(e) => setSelectedInBetweenSoundUrl(e.target.value || null)}
            >
              <option value="">None</option>
              {IN_BETWEEN_SOUNDS.map(({ name, url }) => (
                <option key={url} value={url}>
                  {name}
                </option>
              ))}
            </select>
          </div>

          {tracksLoading && (
            <div className="panel">
              <p>Loading tracks…</p>
            </div>
          )}

          {!tracksLoading && selectedPlaylistId && tracks.length > 0 && (
            <main className="track-list-layout">
              {currentTrack && (
                <section className="now-playing">
                  <h2>Now playing</h2>
                  <div className="current-track">
                    {currentTrack.albumImage && (
                      <img
                        src={currentTrack.albumImage}
                        alt={currentTrack.name}
                        className="cover-art"
                      />
                    )}
                    <div className="track-meta">
                      <div className="track-title">{currentTrack.name}</div>
                      <div className="track-artist">{currentTrack.artists.join(', ')}</div>
                      <div className="progress-wrapper">
                        <div className="progress-bar-bg">
                          <div
                            className="progress-bar-fill"
                            style={{ width: `${clipProgress * 100}%` }}
                          />
                        </div>
                        <div className="progress-labels">
                          <span>{Math.round(clipElapsedMs / 1000)}s</span>
                          <span>{Math.round(clipDurationMs / 1000)}s</span>
                        </div>
                      </div>
                      <div className="controls">
                        <button
                          onClick={handlePrev}
                          disabled={currentIndex === null || currentIndex === 0}
                        >
                          Prev
                        </button>
                        <button
                          onClick={
                            isPlaying ? handlePause : handleResume
                          }
                          disabled={currentIndex === null}
                        >
                          {isPlaying ? 'Pause' : 'Play'}
                        </button>
                        <button
                          onClick={handleNext}
                          disabled={
                            currentIndex === null || currentIndex + 1 >= tracks.length
                          }
                        >
                          Next
                        </button>
                      </div>
                    </div>
                  </div>
                </section>
              )}

              <section className="track-list-section">
                <h2>Tracks ({tracks.length})</h2>
                <ul className="track-list">
                  {tracks.map((track, index) => {
                    const playable = isTrackPlayable(track)
                    const isCurrent = currentIndex === index
                    return (
                      <li
                        key={`${track.id}-${index}`}
                        className={`track-row ${isCurrent ? 'track-row--playing' : ''} ${!playable ? 'track-row--no-preview' : ''}`}
                        onClick={() => playable && playTrackAtIndex(index)}
                        onKeyDown={(e) => {
                          if ((e.key === 'Enter' || e.key === ' ') && playable) {
                            e.preventDefault()
                            handleRowPlayPause(index)
                          }
                        }}
                        role="button"
                        tabIndex={playable ? 0 : -1}
                        aria-disabled={!playable}
                      >
                        <button
                          type="button"
                          className="track-row-play-pause"
                          onClick={(e) => handleRowPlayPause(index, e)}
                          disabled={!playable}
                          aria-label={isCurrent && isPlaying ? 'Pause' : 'Play'}
                          title={isCurrent && isPlaying ? 'Pause' : 'Play'}
                        >
                          {isCurrent && isPlaying ? (
                            <span className="track-row-icon" aria-hidden>⏸</span>
                          ) : (
                            <span className="track-row-icon" aria-hidden>▶</span>
                          )}
                        </button>
                        <span className="track-row-num">{index + 1}</span>
                        {track.albumImage && (
                          <img
                            src={track.albumImage}
                            alt=""
                            className="track-row-art"
                          />
                        )}
                        <div className="track-row-info">
                          <span className="track-row-name">{track.name}</span>
                          <span className="track-row-artists">{track.artists.join(', ')}</span>
                        </div>
                        <span className="track-row-added">
                          Added by{' '}
                          <span className="track-row-added-by">
                            {(track.addedByImageUrl ?? (track.addedById && userProfiles[track.addedById]?.imageUrl)) && (
                              <img
                                src={track.addedByImageUrl ?? userProfiles[track.addedById!]?.imageUrl ?? ''}
                                alt=""
                                className="track-row-avatar"
                              />
                            )}
                            <span>
                              {track.addedBy && track.addedBy !== track.addedById
                                ? track.addedBy
                                : (track.addedById && userProfiles[track.addedById]?.displayName) ?? track.addedBy}
                            </span>
                          </span>
                        </span>
                        <span className="track-row-date">{formatAddedAt(track.addedAt)}</span>
                      </li>
                    )
                  })}
                </ul>
              </section>
            </main>
          )}

          {!tracksLoading && selectedPlaylistId && tracks.length === 0 && (
            <div className="panel">
              <p>This playlist has no tracks.</p>
            </div>
          )}
        </>
      )}
    </div>
  )
}

export default App
