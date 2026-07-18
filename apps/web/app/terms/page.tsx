// Public Terms of Service — linked from App Store Connect and the building pilot
// agreement. Plain-language draft based on docs/multi-tenancy-plan.md ("Operator
// access & audit" clause); have counsel review before signing paid buildings.
// Update "Last updated" whenever the content changes.
export const metadata = { title: 'Terms of Service — 2020EV' };

export default function TermsPage() {
  return (
    // The portal's global background is dark (#0A0F1E); these public pages need
    // their own light canvas to stay readable.
    <main className="min-h-screen bg-white">
      <div className="mx-auto max-w-2xl px-6 py-12 text-gray-800">
      <h1 className="text-3xl font-bold mb-2">Terms of Service</h1>
      <p className="text-sm text-gray-500 mb-8">Last updated: July 11, 2026</p>

      <section className="space-y-6 leading-relaxed">
        <p>
          2020EV is a private service that helps residents of participating buildings
          share an electric-vehicle charger: scheduling time, tracking charging
          sessions, and settling electricity costs. By using the app you agree to
          these terms.
        </p>

        <h2 className="text-xl font-semibold">Accounts</h2>
        <p>
          Accounts are invite-only. You can join only if your building participates in
          2020EV and your building&apos;s administrator sends you an invitation. Your
          account belongs to your building: you can see and act on your own
          building&apos;s charger, schedule, feed, and wallet — never another
          building&apos;s. Keep your login credentials private; you are responsible
          for activity on your account.
        </p>

        <h2 className="text-xl font-semibold">Wallets and billing</h2>
        <p>
          Wallet balances are bookkeeping records of your share of the building&apos;s
          electricity costs, maintained by your building&apos;s administrator. 2020EV
          is not a bank, payment processor, or money transmitter; the app holds no
          funds and processes no payments. Top-ups and settlement happen directly
          between you and your building&apos;s administrator, outside the app.
          Charging sessions are billed to your wallet automatically based on energy
          used and the electricity rate set by your building. If you believe a charge
          is incorrect, contact your building&apos;s administrator, who can review and
          correct it.
        </p>

        <h2 className="text-xl font-semibold">Acceptable use</h2>
        <p>
          The community feed and scheduling tools are shared with your neighbors. Do
          not post unlawful, harassing, or abusive content, and do not attempt to
          access another user&apos;s or another building&apos;s data. Building
          administrators may remove content and, together with 2020EV, may suspend
          accounts that violate these terms.
        </p>

        <h2 className="text-xl font-semibold">Operator access &amp; audit</h2>
        <p>
          Each participating building authorizes 2020EV platform operators to access
          the building&apos;s administrator portal solely to provide support and
          maintain the service. Such access is time-boxed, logged, and the log is
          available to the building&apos;s own administrator. 2020EV acts as a data
          processor for resident data and does not sell resident data. See the{' '}
          <a href="/privacy" className="text-blue-600 underline">
            Privacy Policy
          </a>{' '}
          for details on data handling.
        </p>

        <h2 className="text-xl font-semibold">Cancellation</h2>
        <p>
          You may delete your account at any time from the Profile screen in the app.
          A participating building or 2020EV may end the building&apos;s service with
          30 days&apos; notice; residents&apos; outstanding balances are settled
          directly with the building&apos;s administrator.
        </p>

        <h2 className="text-xl font-semibold">Disclaimers</h2>
        <p>
          The service is provided &ldquo;as is.&rdquo; Charger availability, charging
          data, and status information depend on the building&apos;s ChargePoint
          hardware and third-party services, and may be delayed, interrupted, or
          inaccurate. To the maximum extent permitted by law, 2020EV&apos;s liability
          for any claim related to the service is limited to the amount your building
          paid for the service in the three months before the claim.
        </p>

        <h2 className="text-xl font-semibold">Changes to these terms</h2>
        <p>
          We will give at least 30 days&apos; notice of material changes to these
          terms, via the app or your building&apos;s administrator. Continuing to use
          the app after a change takes effect means you accept the updated terms.
        </p>

        <h2 className="text-xl font-semibold">Contact</h2>
        <p>
          Questions: contact your building&apos;s administrator, or email{' '}
          <a href="mailto:support@2020ev.app" className="text-blue-600 underline">
            support@2020ev.app
          </a>
          .
        </p>
      </section>
      </div>
    </main>
  );
}
