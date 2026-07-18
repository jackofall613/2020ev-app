// Public privacy policy — linked from App Store Connect. Review before first
// public App Store submission; update "Last updated" whenever the content changes.
export const metadata = { title: 'Privacy Policy — 2020EV' };

export default function PrivacyPage() {
  return (
    // The portal's global background is dark (#0A0F1E); these public pages need
    // their own light canvas to stay readable.
    <main className="min-h-screen bg-white">
      <div className="mx-auto max-w-2xl px-6 py-12 text-gray-800">
      <h1 className="text-3xl font-bold mb-2">Privacy Policy</h1>
      <p className="text-sm text-gray-500 mb-8">Last updated: July 5, 2026</p>

      <section className="space-y-6 leading-relaxed">
        <p>
          2020EV is a private app for residents of participating buildings to share an
          electric-vehicle charger: scheduling time, tracking charging sessions, and
          settling electricity costs. This policy describes what the app collects and
          how it is used.
        </p>

        <h2 className="text-xl font-semibold">What we collect</h2>
        <ul className="list-disc pl-6 space-y-1">
          <li>Account details you provide: name, email address, and unit number.</li>
          <li>An optional profile photo, if you choose to add one.</li>
          <li>
            Charging activity: session times and energy used, sourced from the
            building&apos;s ChargePoint charger, and the resulting wallet balance and
            transaction history.
          </li>
          <li>Messages you post to the building&apos;s community feed.</li>
          <li>
            A device push-notification token, only if you enable notifications.
          </li>
        </ul>

        <h2 className="text-xl font-semibold">How it is used</h2>
        <p>
          Data is used solely to operate the service for your building: coordinating
          charger access, billing electricity usage to resident wallets, and sending
          notifications you have opted into. We do not sell data, share it with
          advertisers, or use it for any purpose outside your building&apos;s charger
          program. Your building&apos;s administrator can see resident names, emails,
          balances, and charging history in order to manage billing.
        </p>

        <h2 className="text-xl font-semibold">Data retention and deletion</h2>
        <p>
          You can delete your account at any time from the Profile screen in the app.
          Deletion permanently removes your name, email, photo, and login credentials.
          Charging and payment records are retained in anonymized form because they
          are part of the building&apos;s financial records.
        </p>

        <h2 className="text-xl font-semibold">Support access to building portals</h2>
        <p>
          To provide support and keep the service running, authorized 2020EV platform
          operators may temporarily access a building&apos;s administrator portal
          (a &ldquo;view-as&rdquo; session). Every such access is time-boxed, shown with a
          visible banner while active, and recorded in an access log that the
          building&apos;s own administrator can review at any time in their portal.
          Operators use this access only to assist the building and never to alter
          residents&apos; financial records without the building&apos;s request.
        </p>

        <h2 className="text-xl font-semibold">Third parties</h2>
        <p>
          Charging data comes from ChargePoint&apos;s API for the building&apos;s
          charger. Push notifications are delivered through Apple and Expo&apos;s
          notification services. The service is hosted on Railway and Vercel. No other
          third parties receive your data.
        </p>

        <h2 className="text-xl font-semibold">Contact</h2>
        <p>
          Questions or requests: contact your building&apos;s administrator, or email{' '}
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
