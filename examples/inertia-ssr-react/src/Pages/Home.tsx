interface Props {
  pid: number;
  hostname: string;
}

export default function Home({ pid, hostname }: Readonly<Props>) {
  return (
    <div>
      <h1>Hello from Inertia SSR</h1>
      <p>
        Rendered by worker PID {pid} on {hostname}
      </p>
    </div>
  );
}
