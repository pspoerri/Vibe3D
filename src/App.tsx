import { useMemo } from 'react'
import { parseOff } from './kernel/off'
import { Viewport } from './viewer/Viewport'

const CUBE = `OFF
8 12 0
0 0 0
40 0 0
40 40 0
0 40 0
0 0 40
40 0 40
40 40 40
0 40 40
3 0 3 2
3 0 2 1
3 4 5 6
3 4 6 7
3 0 1 5
3 0 5 4
3 1 2 6
3 1 6 5
3 2 3 7
3 2 7 6
3 3 0 4
3 3 4 7
`

export function App() {
  const mesh = useMemo(() => parseOff(CUBE), [])
  return (
    <div style={{ height: '100vh' }}>
      <Viewport mesh={mesh} />
    </div>
  )
}
