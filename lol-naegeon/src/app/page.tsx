'use client'

import { useState, useEffect } from 'react'
import { supabase } from '@/lib/shared'
import LoginPage from '@/components/LoginPage'
import MainApp from '@/components/MainApp'

export default function App() {
  const [user, setUser] = useState<any>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    // 초기 auth 상태 체크
    const checkAuth = async () => {
      const { data: { session } } = await supabase.auth.getSession()
      setUser(session?.user ?? null)
      setLoading(false)
    }
    checkAuth()

    // auth 상태 변화 리스닝
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      setUser(session?.user ?? null)
    })

    return () => subscription?.unsubscribe()
  }, [])

  if (loading) {
    return (
      <div style={{
        minHeight: '100vh', display: 'flex', justifyContent: 'center', alignItems: 'center',
        background: 'linear-gradient(135deg, #0a0e27 0%, #1a1f3a 100%)'
      }}>
        <div style={{ color: 'var(--text2)' }}>로드 중...</div>
      </div>
    )
  }

  if (!user) {
    return <LoginPage onAuthSuccess={() => {}} />
  }

  return <MainApp />
}
