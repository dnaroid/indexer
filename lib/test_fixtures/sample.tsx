import React, {useState} from 'react'

type Props = {
  title: string
}

export function App(props: Props) {
  return <div>{props.title}</div>
}

export function useFeature() {
  const [value] = useState(0)
  return value
}

export class View extends React.Component<Props> {
  render() {
    return <span>ok</span>
  }
}
