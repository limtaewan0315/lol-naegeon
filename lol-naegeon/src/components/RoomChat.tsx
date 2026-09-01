'use client'

import { useState, useEffect, useRef } from 'react'
import { supabase } from '@/lib/shared'

type RoomMessage = {
  id: number
  room_id: number
  user_id: string
  summoner_name: string
  message: string
  created_at: string
}

export default function RoomChat({ roomId, myName, myUserId }: { roomId: number; myName: string; myUserId: string }) {
  const [messages, setMessages] = useState<RoomMessage[]>([])
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const { data } = await supabase
        .from('room_messages')
        .select('*')
        .eq('room_id', roomId)
        .order('created_at', { ascending: true })
      if (!cancelled) setMessages(data ?? [])
    })()

    // 이 방의 채팅만 실시간 구독
    const channel = supabase
      .channel(`room-chat-${roomId}`)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'room_messages', filter: `room_id=eq.${roomId}` }, (payload) => {
        setMessages(prev => [...prev, payload.new as RoomMessage])
      })
      .subscribe()

    return () => {
      cancelled = true
      supabase.removeChannel(channel)
    }
  }, [roomId])

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight
  }, [messages])

  const send = async () => {
    const text = input.trim()
    if (!text || sending) return
    setSending(true)
    const { data: { session } } = await supabase.auth.getSession()
      const user = session?.user ?? null
    if (!user) { setSending(false); return }
    const { error } = await supabase.from('room_messages').insert({
      room_id: roomId,
      user_id: user.id,
      summoner_name: myName,
      message: text,
    })
    if (!error) setInput('')
    setSending(false)
  }

  const fmtTime = (iso: string) => {
    const d = new Date(iso)
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  }

  return (
    <div className="room-chat">
      <div className="room-chat-header">채팅</div>
      <div className="room-chat-messages" ref={scrollRef}>
        {messages.length === 0 ? (
          <div className="empty">아직 채팅이 없어요</div>
        ) : (
          messages.map(m => {
            const isMe = m.user_id === myUserId
            return (
              <div key={m.id} style={{ alignSelf: isMe ? 'flex-end' : 'flex-start', maxWidth: '85%' }}>
                <div style={{ fontSize: 10, color: 'var(--text3)', marginBottom: 2, textAlign: isMe ? 'right' : 'left' }}>
                  {isMe ? '나' : m.summoner_name} · {fmtTime(m.created_at)}
                </div>
                <div style={{
                  fontSize: 12, padding: '6px 10px',
                  borderRadius: isMe ? '12px 12px 3px 12px' : '12px 12px 12px 3px',
                  background: isMe ? '#2f6fd6' : 'var(--bg3)',
                  color: isMe ? '#fff' : 'var(--text)',
                  fontWeight: isMe ? 500 : 400,
                  wordBreak: 'break-word',
                  whiteSpace: 'pre-wrap',
                }}>
                  {m.message}
                </div>
              </div>
            )
          })
        )}
      </div>
      <div className="room-chat-input">
        <textarea
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              send()
            }
          }}
          placeholder="메시지 입력... (Shift+Enter 줄바꿈)"
          disabled={sending}
          maxLength={300}
          rows={2}
          style={{ resize: 'none', overflowY: 'auto', maxHeight: 72, fontFamily: 'inherit', lineHeight: 1.4, borderRadius: 20 }}
        />
        <button
          onClick={send}
          disabled={sending || !input.trim()}
          style={{
            alignSelf: 'center', padding: '0 16px', height: 32, borderRadius: 16,
            background: 'linear-gradient(135deg, var(--gold2), var(--gold))',
            border: 'none', color: '#1a1206', fontSize: 11, fontWeight: 700,
            cursor: sending || !input.trim() ? 'not-allowed' : 'pointer',
            opacity: sending || !input.trim() ? 0.6 : 1,
            whiteSpace: 'nowrap', flexShrink: 0,
          }}
        >
          전송
        </button>
      </div>
    </div>
  )
}

