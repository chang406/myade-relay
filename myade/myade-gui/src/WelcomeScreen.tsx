type WelcomeScreenProps = {
  onCreatePane: () => void;
};

function WelcomeScreen({ onCreatePane }: WelcomeScreenProps) {
  return (
    <div className="welcome-screen">
      <button onClick={onCreatePane}>+ 새 pane</button>
    </div>
  );
}

export default WelcomeScreen;
